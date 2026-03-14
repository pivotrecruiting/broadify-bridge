import fs from "fs";
import { randomUUID } from "crypto";
import { BridgeIdentityService } from "./bridge-identity.js";

jest.mock("electron", () => ({
  app: { getPath: jest.fn().mockReturnValue("/tmp/bridge-identity-test") },
}));

const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockWriteFileSync = jest.fn();
jest.mock("fs", () => ({
  ...jest.requireActual<typeof import("fs")>("fs"),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
}));

jest.mock("crypto", () => ({
  randomUUID: jest.fn(),
}));

describe("BridgeIdentityService", () => {
  const testUuid = "550e8400-e29b-41d4-a716-446655440000";

  beforeEach(() => {
    jest.clearAllMocks();
    (randomUUID as jest.Mock).mockReturnValue(testUuid);
    // Reset singleton for isolated tests
    (BridgeIdentityService as unknown as { instance: BridgeIdentityService | null }).instance = null;
  });

  describe("getInstance", () => {
    it("returns singleton instance", () => {
      const a = BridgeIdentityService.getInstance();
      const b = BridgeIdentityService.getInstance();
      expect(a).toBe(b);
    });
  });

  describe("getBridgeId", () => {
    it("generates new UUID when file does not exist", () => {
      mockExistsSync.mockReturnValue(false);
      const instance = BridgeIdentityService.getInstance();
      const id = instance.getBridgeId();

      expect(id).toBe(testUuid);
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining("bridge-id.json"),
        expect.stringContaining(testUuid),
        "utf-8"
      );
    });

    it("loads bridgeId from file when valid", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ bridgeId: "existing-uuid-123" })
      );
      const instance = BridgeIdentityService.getInstance();
      const id = instance.getBridgeId();

      expect(id).toBe("existing-uuid-123");
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("returns cached bridgeId on subsequent calls", () => {
      mockExistsSync.mockReturnValue(false);
      const instance = BridgeIdentityService.getInstance();
      const id1 = instance.getBridgeId();
      const id2 = instance.getBridgeId();

      expect(id1).toBe(id2);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    });

    it("generates new UUID when file exists but content is invalid", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{"bridgeId": null}');
      const instance = BridgeIdentityService.getInstance();
      const id = instance.getBridgeId();

      expect(id).toBe(testUuid);
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it("generates new UUID when file read throws", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => {
        throw new Error("read error");
      });
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const instance = BridgeIdentityService.getInstance();
      const id = instance.getBridgeId();

      expect(id).toBe(testUuid);
      expect(mockWriteFileSync).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("resetBridgeId", () => {
    it("generates new UUID and persists it", () => {
      const newUuid = "660e8400-e29b-41d4-a716-446655440001";
      (randomUUID as jest.Mock).mockReturnValue(newUuid);
      mockExistsSync.mockReturnValue(false);
      const instance = BridgeIdentityService.getInstance();
      instance.getBridgeId();

      (randomUUID as jest.Mock).mockReturnValue("another-uuid");
      const resetId = instance.resetBridgeId();

      expect(resetId).toBe("another-uuid");
      expect(mockWriteFileSync).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.stringContaining("another-uuid"),
        "utf-8"
      );
    });
  });
});
