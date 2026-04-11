import {
  RELAY_COMMAND_ALLOWLIST,
  isRelayCommand,
  type RelayCommand,
} from "./relay-command-allowlist.js";

describe("relay-command-allowlist", () => {
  describe("RELAY_COMMAND_ALLOWLIST", () => {
    it("contains expected commands", () => {
      expect(RELAY_COMMAND_ALLOWLIST).toContain("get_status");
      expect(RELAY_COMMAND_ALLOWLIST).toContain("engine_connect");
      expect(RELAY_COMMAND_ALLOWLIST).toContain("engine_vmix_run_action");
      expect(RELAY_COMMAND_ALLOWLIST).toContain("engine_vmix_ensure_browser_input");
      expect(RELAY_COMMAND_ALLOWLIST).toContain("graphics_send");
    });

    it("is readonly tuple", () => {
      expect(Array.isArray(RELAY_COMMAND_ALLOWLIST)).toBe(true);
      expect(RELAY_COMMAND_ALLOWLIST.length).toBeGreaterThan(0);
    });
  });

  describe("isRelayCommand", () => {
    it("returns true for known commands", () => {
      expect(isRelayCommand("get_status")).toBe(true);
      expect(isRelayCommand("engine_connect")).toBe(true);
      expect(isRelayCommand("engine_vmix_run_action")).toBe(true);
      expect(isRelayCommand("engine_vmix_ensure_browser_input")).toBe(true);
      expect(isRelayCommand("graphics_configure_outputs")).toBe(true);
    });

    it("returns false for unknown command", () => {
      expect(isRelayCommand("unknown_command")).toBe(false);
      expect(isRelayCommand("configure_outputs")).toBe(false);
    });

    it("returns false for non-string", () => {
      expect(isRelayCommand(null)).toBe(false);
      expect(isRelayCommand(undefined)).toBe(false);
      expect(isRelayCommand(123)).toBe(false);
    });

    it("narrows type when true", () => {
      const cmd: unknown = "engine_connect";
      if (isRelayCommand(cmd)) {
        const relayCommand: RelayCommand = cmd;
        expect(relayCommand).toBe("engine_connect");
        expect(cmd).toBe("engine_connect");
      }
    });
  });
});
