import { execFile } from "node:child_process";
import { platform as osPlatform } from "node:os";

export type MeetingCallPlatformT = "teams" | "zoom";
export type MeetingCallActionT = "mic_toggle" | "speaker_toggle" | "hangup";

export type MeetingCallControlResultT = {
  platform: MeetingCallPlatformT;
  action: MeetingCallActionT;
  /** Present after speaker_toggle: the new system mute state. */
  speakerMuted?: boolean;
};

export class MeetingCallControlError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "unsupported_os"
      | "client_not_running"
      | "accessibility_permission_required"
      | "automation_failed",
  ) {
    super(message);
    this.name = "MeetingCallControlError";
  }
}

/** macOS process names as reported by System Events. */
const PLATFORM_PROCESS_NAMES: Record<MeetingCallPlatformT, string[]> = {
  teams: ["Microsoft Teams", "MSTeams", "Microsoft Teams (work or school)"],
  zoom: ["zoom.us"],
};

const PLATFORM_APP_NAMES: Record<MeetingCallPlatformT, string> = {
  teams: "Microsoft Teams",
  zoom: "zoom.us",
};

function runOsascript(script: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-e", script],
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          const detail = `${stderr || ""} ${error.message}`;
          if (/assistive access|not authorized|-25211|-1719/i.test(detail)) {
            reject(
              new MeetingCallControlError(
                "macOS accessibility permission is required to control the meeting client. Grant it in System Settings > Privacy & Security > Accessibility.",
                "accessibility_permission_required",
              ),
            );
            return;
          }
          reject(new MeetingCallControlError(detail.trim(), "automation_failed"));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function findRunningProcessName(
  platform: MeetingCallPlatformT,
): Promise<string> {
  const names = await runOsascript(
    'tell application "System Events" to get name of every process',
  );
  const running = PLATFORM_PROCESS_NAMES[platform].find((candidate) =>
    names.split(", ").includes(candidate),
  );
  if (!running) {
    throw new MeetingCallControlError(
      `${PLATFORM_APP_NAMES[platform]} is not running.`,
      "client_not_running",
    );
  }
  return running;
}

/**
 * Brings the client to the front and sends its official shortcut. Focus is
 * required for app-local shortcuts; the client window will briefly become
 * frontmost (documented V1 limitation).
 */
async function sendShortcutToClient(
  platform: MeetingCallPlatformT,
  keystrokeLine: string,
): Promise<void> {
  const processName = await findRunningProcessName(platform);
  await runOsascript(
    [
      `tell application "System Events" to set frontmost of process "${processName}" to true`,
      "delay 0.25",
      `tell application "System Events" to ${keystrokeLine}`,
    ].join("\n"),
  );
}

async function toggleSystemSpeakerMute(): Promise<boolean> {
  const result = await runOsascript(
    [
      "set currentlyMuted to output muted of (get volume settings)",
      "set volume output muted (not currentlyMuted)",
      "return not currentlyMuted",
    ].join("\n"),
  );
  return result === "true";
}

/**
 * Executes a call-control action against the selected meeting client.
 * Mic toggle and hangup use the client's official keyboard shortcuts
 * (Teams: Cmd+Shift+M / Cmd+Shift+H, Zoom: Cmd+Shift+A / Cmd+W + Return);
 * the speaker toggle mutes the system output and works without focus.
 */
export async function executeMeetingCallControl(
  platform: MeetingCallPlatformT,
  action: MeetingCallActionT,
): Promise<MeetingCallControlResultT> {
  if (osPlatform() !== "darwin") {
    throw new MeetingCallControlError(
      "Meeting client control is only available on macOS.",
      "unsupported_os",
    );
  }

  if (action === "speaker_toggle") {
    const speakerMuted = await toggleSystemSpeakerMute();
    return { platform, action, speakerMuted };
  }

  if (action === "mic_toggle") {
    const keystroke =
      platform === "teams"
        ? 'keystroke "m" using {command down, shift down}'
        : 'keystroke "a" using {command down, shift down}';
    await sendShortcutToClient(platform, keystroke);
    return { platform, action };
  }

  // hangup
  if (platform === "teams") {
    await sendShortcutToClient(platform, 'keystroke "h" using {command down, shift down}');
  } else {
    // Zoom: Cmd+W opens the leave dialog; Return confirms "Leave meeting".
    await sendShortcutToClient(
      platform,
      'keystroke "w" using {command down}\ndelay 0.35\ntell application "System Events" to key code 36',
    );
  }
  return { platform, action };
}
