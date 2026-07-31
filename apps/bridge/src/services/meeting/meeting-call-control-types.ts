export type MeetingCallPlatformT = "teams" | "zoom";
export type MeetingCallActionT = "mic_toggle" | "speaker_toggle" | "hangup";

export type MeetingCallControlResultT = {
  platform: MeetingCallPlatformT;
  action: MeetingCallActionT;
  /**
   * Present after speaker_toggle where the platform can read the new state
   * back (macOS). The Windows driver toggles via the VK_VOLUME_MUTE media key
   * and omits it.
   */
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