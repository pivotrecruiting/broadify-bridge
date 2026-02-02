import { randomBytes } from "crypto";

/**
 * Pairing session details shared with the UI.
 */
export type BridgePairingInfo = {
  code: string;
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
  expired: boolean;
};

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const CODE_LENGTH = 8;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Bridge pairing service.
 *
 * Generates and manages short-lived pairing codes for bridge ownership setup.
 */
export class BridgePairingService {
  private info: BridgePairingInfo | null = null;
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Start a new pairing session (generate fresh code).
   */
  startPairing(): BridgePairingInfo {
    const createdAt = Date.now();
    const expiresAt = createdAt + this.ttlMs;
    const code = this.generateCode(CODE_LENGTH);

    this.info = {
      code,
      createdAt,
      expiresAt,
      ttlMs: this.ttlMs,
      expired: false,
    };

    return this.getPairingInfo() as BridgePairingInfo;
  }

  /**
   * Get current pairing info, if any.
   */
  getPairingInfo(): BridgePairingInfo | null {
    if (!this.info) {
      return null;
    }

    const expired = Date.now() >= this.info.expiresAt;
    return {
      ...this.info,
      expired,
    };
  }

  /**
   * Clear pairing info (e.g., after bridge stops).
   */
  clear(): void {
    this.info = null;
  }

  private generateCode(length: number): string {
    const bytes = randomBytes(length);
    let result = "";
    for (let i = 0; i < length; i++) {
      const index = bytes[i] % CODE_ALPHABET.length;
      result += CODE_ALPHABET[index];
    }
    return result;
  }
}

export const bridgePairing = new BridgePairingService();
