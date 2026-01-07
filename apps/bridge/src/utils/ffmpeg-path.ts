import fs from "node:fs";
import path from "node:path";

/**
 * Check if FFmpeg at given path is likely a Blackmagic build
 *
 * Blackmagic FFmpeg is typically compiled with DeckLink support.
 * We can't detect this reliably without running it, but we can check
 * if it's in the expected location for manually placed Blackmagic FFmpeg.
 */
function isLikelyBlackmagicFfmpeg(ffmpegPath: string): boolean {
  // If path contains "blackmagic" or is in resources/ffmpeg, assume it's Blackmagic
  // (since we check for manually placed Blackmagic FFmpeg first)
  return (
    ffmpegPath.toLowerCase().includes("blackmagic") ||
    (ffmpegPath.includes("resources") && ffmpegPath.includes("ffmpeg"))
  );
}

/**
 * Resolve FFmpeg executable path
 *
 * Priority:
 * 1. FFMPEG_PATH environment variable
 * 2. Bundled Blackmagic FFmpeg in production (manually placed, has DeckLink support)
 * 3. Bundled BtbN FFmpeg in production (downloaded, may not have DeckLink support)
 * 4. System FFmpeg (fallback)
 *
 * This function is used consistently across all FFmpeg-related code.
 */
export function resolveFfmpegPath(): string {
  // Check environment variable first
  if (process.env.FFMPEG_PATH) {
    return process.env.FFMPEG_PATH;
  }

  // In production, use bundled FFmpeg from resources
  // process.resourcesPath is set by Electron and points to the resources directory
  if (
    process.env.NODE_ENV === "production" &&
    typeof process.resourcesPath !== "undefined"
  ) {
    const platform = process.platform;
    const arch = process.arch;

    let platformDir = "";
    if (platform === "darwin") {
      platformDir = arch === "arm64" ? "mac-arm64" : "mac-x64";
    } else if (platform === "win32") {
      platformDir = "win";
    } else if (platform === "linux") {
      platformDir = "linux";
    }

    if (platformDir) {
      const bundledPath = path.join(
        process.resourcesPath,
        "ffmpeg",
        platformDir,
        platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
      );

      // Check if bundled FFmpeg exists
      if (fs.existsSync(bundledPath)) {
        return bundledPath;
      }
    }
  }

  // Fallback to system FFmpeg
  return "ffmpeg";
}

/**
 * Get information about the resolved FFmpeg path
 *
 * Returns metadata about which FFmpeg is being used.
 */
export function getFfmpegInfo(): {
  path: string;
  source: "env" | "bundled-blackmagic" | "bundled-btbn" | "system";
  hasDeckLinkSupport: boolean | null; // null = unknown
} {
  const ffmpegPath = resolveFfmpegPath();

  if (process.env.FFMPEG_PATH) {
    return {
      path: ffmpegPath,
      source: "env",
      hasDeckLinkSupport: null, // Unknown, depends on what user set
    };
  }

  if (
    process.env.NODE_ENV === "production" &&
    typeof process.resourcesPath !== "undefined"
  ) {
    const platform = process.platform;
    const arch = process.arch;

    let platformDir = "";
    if (platform === "darwin") {
      platformDir = arch === "arm64" ? "mac-arm64" : "mac-x64";
    } else if (platform === "win32") {
      platformDir = "win";
    } else if (platform === "linux") {
      platformDir = "linux";
    }

    if (platformDir) {
      const bundledPath = path.join(
        process.resourcesPath,
        "ffmpeg",
        platformDir,
        platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
      );

      if (fs.existsSync(bundledPath)) {
        // Check if it's likely Blackmagic FFmpeg
        // (manually placed Blackmagic FFmpeg is assumed to have DeckLink support)
        const isBlackmagic = isLikelyBlackmagicFfmpeg(bundledPath);
        return {
          path: bundledPath,
          source: isBlackmagic ? "bundled-blackmagic" : "bundled-btbn",
          hasDeckLinkSupport: isBlackmagic ? true : null, // BtbN may or may not have it
        };
      }
    }
  }

  return {
    path: ffmpegPath,
    source: "system",
    hasDeckLinkSupport: null, // Unknown
  };
}

