import { execFile } from "node:child_process";
import {
  MeetingCallControlError,
  type MeetingCallActionT,
  type MeetingCallControlResultT,
  type MeetingCallPlatformT,
} from "./meeting-call-control-types.js";

/**
 * Windows driver: PowerShell with an inline user32 P/Invoke shim
 * (SetForegroundWindow + keybd_event). Every script is assembled exclusively
 * from the constants below - the command payload is Zod-enum-validated
 * upstream and nothing user-influenced ever reaches the script text.
 *
 * Known V1 limitations (upgrade path: a signed native call helper next to
 * display-helper.exe):
 * - A popped-out Teams meeting window may not receive the shortcut; we target
 *   the process main window.
 * - If the client runs elevated and the bridge does not, UIPI silently drops
 *   the injected input.
 * - PowerShell Constrained Language Mode (WDAC/AppLocker) blocks Add-Type;
 *   this surfaces as automation_failed.
 * - Like on macOS, the client briefly becomes the frontmost window.
 */

/** Get-Process names (no .exe): new Teams, classic Teams, Zoom. */
const WIN32_PROCESS_NAMES: Record<MeetingCallPlatformT, string[]> = {
  teams: ["ms-teams", "Teams"],
  zoom: ["Zoom"],
};

const WIN32_APP_LABELS: Record<MeetingCallPlatformT, string> = {
  teams: "Microsoft Teams",
  zoom: "Zoom",
};

/** Windows virtual-key codes used in the shortcut chords. */
const VK = {
  SHIFT: 0x10,
  CONTROL: 0x11,
  MENU: 0x12, // Alt
  RETURN: 0x0d,
  A: 0x41,
  H: 0x48,
  M: 0x4d,
  Q: 0x51,
} as const;

type Win32ShortcutT = {
  modifiers: number[];
  key: number;
  /** Extra key sent after a delay (Zoom's leave confirmation). */
  followUpKey?: number;
  followUpDelayMs?: number;
};

const WIN32_SHORTCUTS: Record<
  MeetingCallPlatformT,
  Record<"mic_toggle" | "hangup", Win32ShortcutT>
> = {
  teams: {
    mic_toggle: { modifiers: [VK.CONTROL, VK.SHIFT], key: VK.M }, // Ctrl+Shift+M
    hangup: { modifiers: [VK.CONTROL, VK.SHIFT], key: VK.H }, // Ctrl+Shift+H
  },
  zoom: {
    mic_toggle: { modifiers: [VK.MENU], key: VK.A }, // Alt+A
    hangup: {
      modifiers: [VK.MENU],
      key: VK.Q, // Alt+Q opens the leave dialog ...
      followUpKey: VK.RETURN, // ... Enter confirms "Leave meeting".
      followUpDelayMs: 350,
    },
  },
};

const KEYEVENTF_KEYUP = 2;
const SW_RESTORE = 9;
/** Settle time after SetForegroundWindow before verifying + sending keys. */
const FOCUS_SETTLE_MS = 300;

const NATIVE = "[Broadify.CallControlNative]";

const ADD_TYPE_BLOCK = [
  "Add-Type -Namespace Broadify -Name CallControlNative -MemberDefinition @'",
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
  '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
  '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
  "'@",
].join("\n");

const toHex = (value: number): string => `0x${value.toString(16)}`;

const keyDown = (vk: number): string =>
  `${NATIVE}::keybd_event(${toHex(vk)}, 0, 0, [UIntPtr]::Zero)`;

const keyUp = (vk: number): string =>
  `${NATIVE}::keybd_event(${toHex(vk)}, 0, ${KEYEVENTF_KEYUP}, [UIntPtr]::Zero)`;

const keyTap = (vk: number): string[] => [keyDown(vk), keyUp(vk)];

/**
 * Builds the focus-and-send script for one platform+shortcut. Stages report a
 * distinct JSON result so failures map to precise error codes.
 */
function buildShortcutScript(
  platform: MeetingCallPlatformT,
  shortcut: Win32ShortcutT,
): string {
  const processNames = WIN32_PROCESS_NAMES[platform]
    .map((name) => `'${name}'`)
    .join(",");
  const chord = [
    ...shortcut.modifiers.map(keyDown),
    ...keyTap(shortcut.key),
    ...[...shortcut.modifiers].reverse().map(keyUp),
  ];
  const followUp = shortcut.followUpKey
    ? [
        `Start-Sleep -Milliseconds ${shortcut.followUpDelayMs ?? 350}`,
        ...keyTap(shortcut.followUpKey),
      ]
    : [];
  return [
    "$ErrorActionPreference = 'Stop'",
    ADD_TYPE_BLOCK,
    `$process = Get-Process -Name @(${processNames}) -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1`,
    `if (-not $process) { Write-Output '{"result":"not_found"}'; exit 0 }`,
    "$window = $process.MainWindowHandle",
    // Alt tap: makes this process the last-input source, which unlocks the
    // SetForegroundWindow restriction for background processes.
    keyDown(VK.MENU),
    keyUp(VK.MENU),
    `if (${NATIVE}::IsIconic($window)) { ${NATIVE}::ShowWindow($window, ${SW_RESTORE}) | Out-Null }`,
    `${NATIVE}::SetForegroundWindow($window) | Out-Null`,
    `Start-Sleep -Milliseconds ${FOCUS_SETTLE_MS}`,
    `if (${NATIVE}::GetForegroundWindow() -ne $window) { Write-Output '{"result":"activation_failed"}'; exit 0 }`,
    ...chord,
    ...followUp,
    `Write-Output '{"result":"ok"}'`,
  ].join("\n");
}

/**
 * VK_VOLUME_MUTE ([char]173) via SendKeys toggles the system output mute
 * without any window focus or P/Invoke - but offers no state read-back.
 */
const SPEAKER_TOGGLE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "(New-Object -ComObject WScript.Shell).SendKeys([char]173)",
  `Write-Output '{"result":"ok"}'`,
].join("\n");

function runPowershell(script: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        // -EncodedCommand sidesteps every quoting/escaping concern.
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = `${stderr || ""} ${error.message}`.trim();
          reject(new MeetingCallControlError(detail, "automation_failed"));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function parseScriptResult(output: string): string {
  // The status JSON is the last line; Add-Type or profile noise may precede it.
  const lastLine = output.split(/\r?\n/).filter(Boolean).pop() ?? "";
  try {
    const parsed = JSON.parse(lastLine) as { result?: unknown };
    return typeof parsed.result === "string" ? parsed.result : "";
  } catch {
    return "";
  }
}

/** Windows driver entry - same contract as the macOS driver. */
export async function executeMeetingCallControlWin32(
  platform: MeetingCallPlatformT,
  action: MeetingCallActionT,
): Promise<MeetingCallControlResultT> {
  if (action === "speaker_toggle") {
    await runPowershell(SPEAKER_TOGGLE_SCRIPT);
    // No speakerMuted read-back on Windows (see type docs).
    return { platform, action };
  }

  const script = buildShortcutScript(platform, WIN32_SHORTCUTS[platform][action]);
  const output = await runPowershell(script);
  const result = parseScriptResult(output);
  if (result === "not_found") {
    throw new MeetingCallControlError(
      `${WIN32_APP_LABELS[platform]} is not running.`,
      "client_not_running",
    );
  }
  if (result === "activation_failed") {
    throw new MeetingCallControlError(
      `Could not focus the ${WIN32_APP_LABELS[platform]} window.`,
      "automation_failed",
    );
  }
  if (result !== "ok") {
    throw new MeetingCallControlError(
      `Unexpected automation output: ${output || "<empty>"}`,
      "automation_failed",
    );
  }
  return { platform, action };
}