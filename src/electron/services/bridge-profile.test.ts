import { bridgeIdentity } from "./bridge-identity.js";
import { BridgeProfileService, bridgeProfile } from "./bridge-profile.js";

jest.mock("electron", () => ({
  app: { getPath: jest.fn().mockReturnValue("/tmp/bridge-profile-test") },
}));

jest.mock("./bridge-identity.js", () => ({
  bridgeIdentity: { getBridgeId: jest.fn().mockReturnValue("test-bridge-id") },
}));

const mockExistsSync = jest.fn().mockReturnValue(false);
const mockReadFileSync = jest.fn().mockReturnValue("{}");
const mockWriteFileSync = jest.fn();
const mockRenameSync = jest.fn();
jest.mock("fs", () => ({
  ...jest.requireActual<typeof import("fs")>("fs"),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  renameSync: (...args: unknown[]) => mockRenameSync(...args),
}));

describe("BridgeProfileService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (bridgeIdentity.getBridgeId as jest.Mock).mockReturnValue("test-bridge-id");
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("{}");
  });

  describe("getInstance", () => {
    it("returns singleton instance", () => {
      const a = BridgeProfileService.getInstance();
      const b = BridgeProfileService.getInstance();
      expect(a).toBe(b);
    });
  });

  describe("getProfile", () => {
    it("returns profile with bridgeId from bridgeIdentity when no file exists", () => {
      mockExistsSync.mockReturnValue(false);

      const profile = bridgeProfile.getProfile();

      expect(profile.bridgeId).toBe("test-bridge-id");
      expect(profile.bridgeName).toBeNull();
      expect(profile.termsAcceptedAt).toBeNull();
      expect(profile.updatedAt).toBeNull();
      expect(bridgeIdentity.getBridgeId).toHaveBeenCalled();
    });

    it("returns persisted bridgeName when file exists", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          bridgeName: "My Bridge",
          termsAcceptedAt: null,
          updatedAt: "2024-01-01T00:00:00.000Z",
        })
      );
      jest.resetModules();
      const { bridgeProfile: freshProfile } = await import("./bridge-profile.js");

      const profile = freshProfile.getProfile();

      expect(profile.bridgeName).toBe("My Bridge");
      expect(profile.termsAcceptedAt).toBeNull();
      expect(profile.updatedAt).toBe("2024-01-01T00:00:00.000Z");
    });
  });

  describe("setBridgeName", () => {
    it("persists name and returns updated profile", () => {
      mockExistsSync.mockReturnValue(false);
      bridgeProfile.getProfile();

      const profile = bridgeProfile.setBridgeName("Studio A");

      expect(profile.bridgeName).toBe("Studio A");
      expect(profile.bridgeId).toBe("test-bridge-id");
      expect(mockWriteFileSync).toHaveBeenCalled();
      expect(mockRenameSync).toHaveBeenCalled();
    });

    it("throws when name is empty", () => {
      expect(() => bridgeProfile.setBridgeName("")).toThrow(
        "Bridge name cannot be empty"
      );
    });

    it("throws when name is only whitespace", () => {
      expect(() => bridgeProfile.setBridgeName("   ")).toThrow(
        "Bridge name cannot be empty"
      );
    });

    it("throws when name exceeds 64 characters", () => {
      expect(() => bridgeProfile.setBridgeName("a".repeat(65))).toThrow(
        "Bridge name cannot exceed 64 characters"
      );
    });

    it("accepts name with exactly 64 characters", () => {
      const name = "a".repeat(64);
      const profile = bridgeProfile.setBridgeName(name);
      expect(profile.bridgeName).toBe(name);
    });
  });

  describe("setTermsAccepted", () => {
    it("persists terms acceptance and returns updated profile", () => {
      mockExistsSync.mockReturnValue(false);
      bridgeProfile.getProfile();

      const profile = bridgeProfile.setTermsAccepted();

      expect(profile.termsAcceptedAt).toBeDefined();
      expect(profile.updatedAt).toBeDefined();
      expect(mockWriteFileSync).toHaveBeenCalled();
      expect(mockRenameSync).toHaveBeenCalled();
    });
  });
});
