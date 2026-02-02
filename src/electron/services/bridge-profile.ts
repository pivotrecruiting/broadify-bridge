import { app } from "electron";
import fs from "fs";
import path from "path";
import { bridgeIdentity } from "./bridge-identity.js";

/**
 * Stored bridge identity settings persisted to disk.
 */
export type BridgeProfile = {
  bridgeId: string;
  bridgeName: string | null;
  updatedAt: string | null;
};

const PROFILE_FILE_NAME = "bridge-profile.json";
const MAX_NAME_LENGTH = 64;

/**
 * Bridge profile service.
 *
 * Persists the user-defined bridge name in the Electron userData directory.
 */
export class BridgeProfileService {
  private static instance: BridgeProfileService | null = null;
  private readonly profileFilePath: string;
  private cachedProfile: BridgeProfile | null = null;

  private constructor() {
    this.profileFilePath = path.join(app.getPath("userData"), PROFILE_FILE_NAME);
  }

  /**
   * Get singleton instance.
   */
  static getInstance(): BridgeProfileService {
    if (!BridgeProfileService.instance) {
      BridgeProfileService.instance = new BridgeProfileService();
    }
    return BridgeProfileService.instance;
  }

  /**
   * Get the stored bridge profile (bridgeId + bridgeName).
   */
  getProfile(): BridgeProfile {
    if (this.cachedProfile) {
      return this.cachedProfile;
    }

    const bridgeId = bridgeIdentity.getBridgeId();
    let bridgeName: string | null = null;
    let updatedAt: string | null = null;

    try {
      if (fs.existsSync(this.profileFilePath)) {
        const raw = fs.readFileSync(this.profileFilePath, "utf-8");
        const parsed = JSON.parse(raw) as {
          bridgeName?: string;
          updatedAt?: string;
        };
        if (parsed.bridgeName && typeof parsed.bridgeName === "string") {
          bridgeName = parsed.bridgeName;
        }
        if (parsed.updatedAt && typeof parsed.updatedAt === "string") {
          updatedAt = parsed.updatedAt;
        }
      }
    } catch (error) {
      console.error("[BridgeProfile] Error loading profile:", error);
    }

    this.cachedProfile = {
      bridgeId,
      bridgeName,
      updatedAt,
    };

    return this.cachedProfile;
  }

  /**
   * Set and persist the bridge name.
   *
   * @param name User-defined bridge name.
   */
  setBridgeName(name: string): BridgeProfile {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Bridge name cannot be empty");
    }
    if (trimmed.length > MAX_NAME_LENGTH) {
      throw new Error(`Bridge name cannot exceed ${MAX_NAME_LENGTH} characters`);
    }

    const profile: BridgeProfile = {
      bridgeId: bridgeIdentity.getBridgeId(),
      bridgeName: trimmed,
      updatedAt: new Date().toISOString(),
    };

    this.writeProfile(profile);
    this.cachedProfile = profile;
    return profile;
  }

  private writeProfile(profile: BridgeProfile): void {
    const payload = JSON.stringify(
      {
        bridgeName: profile.bridgeName,
        updatedAt: profile.updatedAt,
      },
      null,
      2
    );

    const tempPath = `${this.profileFilePath}.tmp`;
    try {
      fs.writeFileSync(tempPath, payload, "utf-8");
      fs.renameSync(tempPath, this.profileFilePath);
    } catch (error) {
      console.error("[BridgeProfile] Error saving profile:", error);
    }
  }
}

export const bridgeProfile = BridgeProfileService.getInstance();
