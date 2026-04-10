import {
  getUpdaterEnv,
  __setUpdaterEnvForTesting,
} from "./updater-env.js";

describe("updater-env", () => {
  afterEach(() => {
    __setUpdaterEnvForTesting(null);
  });

  describe("getUpdaterEnv", () => {
    it("returns empty object when import.meta.env is not available", () => {
      const result = getUpdaterEnv();
      expect(result).toEqual({});
      expect(typeof result).toBe("object");
      expect(Array.isArray(result)).toBe(false);
    });

    it("returns override when __setUpdaterEnvForTesting was set", () => {
      const mockEnv = {
        VITE_APP_UPDATER: "1",
        MODE: "development",
      };
      __setUpdaterEnvForTesting(mockEnv);

      const result = getUpdaterEnv();
      expect(result).toEqual(mockEnv);
      expect(result.VITE_APP_UPDATER).toBe("1");
      expect(result.MODE).toBe("development");
    });

    it("returns empty object after reset with null", () => {
      __setUpdaterEnvForTesting({ VITE_APP_UPDATER: "1" });
      expect(getUpdaterEnv()).toEqual({ VITE_APP_UPDATER: "1" });

      __setUpdaterEnvForTesting(null);
      expect(getUpdaterEnv()).toEqual({});
    });

    it("returns object with boolean values when override has booleans", () => {
      __setUpdaterEnvForTesting({
        DEV: true,
        PROD: false,
      });

      const result = getUpdaterEnv();
      expect(result.DEV).toBe(true);
      expect(result.PROD).toBe(false);
    });
  });
});
