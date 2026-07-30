import { platform as osPlatform } from "node:os";
import { executeMeetingCallControlDarwin } from "./meeting-call-control-darwin.js";
import { executeMeetingCallControlWin32 } from "./meeting-call-control-win32.js";
import {
  MeetingCallControlError,
  type MeetingCallActionT,
  type MeetingCallControlResultT,
  type MeetingCallPlatformT,
} from "./meeting-call-control-types.js";

export {
  MeetingCallControlError,
  type MeetingCallActionT,
  type MeetingCallControlResultT,
  type MeetingCallPlatformT,
};

/**
 * Executes a call-control action against the selected meeting client by
 * dispatching to the OS driver: osascript keystrokes on macOS, PowerShell +
 * user32 input injection on Windows. The public contract (payload schema,
 * result shape, error codes) is identical on both platforms.
 */
export async function executeMeetingCallControl(
  platform: MeetingCallPlatformT,
  action: MeetingCallActionT,
): Promise<MeetingCallControlResultT> {
  switch (osPlatform()) {
    case "darwin":
      return executeMeetingCallControlDarwin(platform, action);
    case "win32":
      return executeMeetingCallControlWin32(platform, action);
    default:
      throw new MeetingCallControlError(
        "Meeting client control is only available on macOS and Windows.",
        "unsupported_os",
      );
  }
}