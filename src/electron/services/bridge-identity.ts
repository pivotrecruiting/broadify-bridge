import { app } from "electron";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

/**
 * Bridge Identity Service
 * 
 * Manages bridge identity (bridgeId) - generates and persists UUID
 * Stores in userData/bridge-id.json
 */
export class BridgeIdentityService {
  private static instance: BridgeIdentityService | null = null;
  private bridgeId: string | null = null;
  private readonly identityFilePath: string;

  private constructor() {
    // Store in Electron's userData directory
    this.identityFilePath = path.join(
      app.getPath("userData"),
      "bridge-id.json"
    );
  }

  /**
   * Get singleton instance
   */
  static getInstance(): BridgeIdentityService {
    if (!BridgeIdentityService.instance) {
      BridgeIdentityService.instance = new BridgeIdentityService();
    }
    return BridgeIdentityService.instance;
  }

  /**
   * Get or create bridge ID
   * Generates new UUID if not exists, otherwise loads from file
   */
  getBridgeId(): string {
    if (this.bridgeId) {
      return this.bridgeId;
    }

    // Try to load from file
    try {
      if (fs.existsSync(this.identityFilePath)) {
        const data = fs.readFileSync(this.identityFilePath, "utf-8");
        const parsed = JSON.parse(data) as { bridgeId: string };
        if (parsed.bridgeId && typeof parsed.bridgeId === "string") {
          this.bridgeId = parsed.bridgeId;
          return this.bridgeId;
        }
      }
    } catch (error) {
      console.error("[BridgeIdentity] Error loading bridge ID:", error);
    }

    // Generate new UUID
    this.bridgeId = randomUUID();
    this.saveBridgeId();

    return this.bridgeId;
  }

  /**
   * Save bridge ID to file
   */
  private saveBridgeId(): void {
    if (!this.bridgeId) {
      return;
    }

    try {
      const data = JSON.stringify({ bridgeId: this.bridgeId }, null, 2);
      fs.writeFileSync(this.identityFilePath, data, "utf-8");
      console.log(`[BridgeIdentity] Bridge ID saved: ${this.bridgeId}`);
    } catch (error) {
      console.error("[BridgeIdentity] Error saving bridge ID:", error);
    }
  }

  /**
   * Reset bridge ID (generates new one)
   * Useful for testing or if bridge needs new identity
   */
  resetBridgeId(): string {
    this.bridgeId = randomUUID();
    this.saveBridgeId();
    return this.bridgeId;
  }
}

// Export singleton instance getter
export const bridgeIdentity = BridgeIdentityService.getInstance();

