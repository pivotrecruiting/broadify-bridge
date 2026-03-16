import {
  getBindAddress,
  getPortConfig,
  getDefaultPortForBinding,
} from "./network-utils.js";
import type { InterfacePortConfigT, NetworkBindingOptionT } from "@broadify/protocol";

const createOption = (
  id: string,
  bindAddress: string,
  portConfig?: InterfacePortConfigT
): NetworkBindingOptionT => ({
  id,
  label: `Option ${id}`,
  bindAddress,
  interface: id,
  recommended: false,
  advanced: false,
  portConfig,
});

describe("network-utils", () => {
  describe("getBindAddress", () => {
    it("returns bindAddress when option found", () => {
      const options = [
        createOption("lan", "0.0.0.0"),
        createOption("local", "127.0.0.1"),
      ];
      expect(getBindAddress("lan", options)).toBe("0.0.0.0");
      expect(getBindAddress("local", options)).toBe("127.0.0.1");
    });

    it("returns 127.0.0.1 when option not found", () => {
      expect(getBindAddress("missing", [])).toBe("127.0.0.1");
    });
  });

  describe("getPortConfig", () => {
    it("returns portConfig when option has it", () => {
      const portConfig = { customOnly: true, defaultPort: 8787 };
      const options = [
        createOption("lan", "0.0.0.0", portConfig),
      ];
      expect(getPortConfig("lan", options)).toEqual(portConfig);
    });

    it("returns undefined when option not found", () => {
      expect(getPortConfig("missing", [])).toBeUndefined();
    });

    it("returns undefined when option has no portConfig", () => {
      const options = [createOption("lan", "0.0.0.0")];
      expect(getPortConfig("lan", options)).toBeUndefined();
    });
  });

  describe("getDefaultPortForBinding", () => {
    it("returns defaultPort from option when set", () => {
      const options = [
        createOption("lan", "0.0.0.0", { customOnly: false, defaultPort: 9000 }),
      ];
      expect(getDefaultPortForBinding("lan", options, 8787)).toBe(9000);
    });

    it("returns globalDefault when option has no defaultPort", () => {
      const options = [
        createOption("lan", "0.0.0.0", { customOnly: true }),
      ];
      expect(getDefaultPortForBinding("lan", options, 8787)).toBe(8787);
    });

    it("returns globalDefault when option not found", () => {
      expect(getDefaultPortForBinding("missing", [], 9999)).toBe(9999);
    });
  });
});
