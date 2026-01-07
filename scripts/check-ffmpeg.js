#!/usr/bin/env node

/**
 * Check FFmpeg setup and DeckLink support
 * 
 * This script checks if Blackmagic FFmpeg is present and validates
 * the FFmpeg setup before building.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");
const resourcesDir = path.join(rootDir, "resources", "ffmpeg");

const platforms = {
  "darwin-arm64": {
    name: "mac-arm64",
    binaryName: "ffmpeg",
  },
  "darwin-x64": {
    name: "mac-x64",
    binaryName: "ffmpeg",
  },
  "win32-x64": {
    name: "win",
    binaryName: "ffmpeg.exe",
  },
  "linux-x64": {
    name: "linux",
    binaryName: "ffmpeg",
  },
};

/**
 * Get current platform key
 */
function getCurrentPlatform() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin") {
    return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  } else if (platform === "win32") {
    return "win32-x64";
  } else if (platform === "linux") {
    return "linux-x64";
  }
  return null;
}

/**
 * Check if platform is compatible with current environment
 */
function isPlatformCompatible(platformKey, binaryName) {
  const currentPlatform = getCurrentPlatform();
  if (platformKey !== currentPlatform) {
    return false;
  }

  // Additional checks
  if (process.platform === "win32" && !binaryName.endsWith(".exe")) {
    return false;
  }
  if (process.platform !== "win32" && binaryName.endsWith(".exe")) {
    return false;
  }

  return true;
}

/**
 * Check if FFmpeg exists for a platform
 */
function checkFfmpeg(platformName, binaryName) {
  const ffmpegPath = path.join(resourcesDir, platformName, binaryName);
  return fs.existsSync(ffmpegPath);
}

/**
 * Test FFmpeg DeckLink support
 */
function testDeckLinkSupport(ffmpegPath) {
  return new Promise((resolve) => {
    // Check if file exists and is executable
    if (!fs.existsSync(ffmpegPath)) {
      resolve(false);
      return;
    }

    // Check file permissions on Unix systems
    if (process.platform !== "win32") {
      try {
        const stats = fs.statSync(ffmpegPath);
        // Check if file is executable (readable and has execute bit)
        if (!(stats.mode & 0o111)) {
          console.warn(`  Warning: ${ffmpegPath} is not executable`);
          resolve(false);
          return;
        }
      } catch (err) {
        console.warn(`  Warning: Could not check permissions for ${ffmpegPath}: ${err.message}`);
        resolve(false);
        return;
      }
    }

    const ffmpegProcess = spawn(ffmpegPath, [
      "-f",
      "decklink",
      "-list_devices",
      "1",
      "-i",
      "dummy",
    ]);

    let stderr = "";
    const timeout = setTimeout(() => {
      ffmpegProcess.kill("SIGTERM");
      resolve(false);
    }, 3000);

    ffmpegProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpegProcess.on("close", () => {
      clearTimeout(timeout);
      const hasNoSupport =
        stderr.includes("Unknown input format: decklink") ||
        stderr.includes("No such filter or encoder: decklink");
      resolve(!hasNoSupport);
    });

    ffmpegProcess.on("error", (err) => {
      clearTimeout(timeout);
      // Handle ENOEXEC (Exec format error) - binary is not for this platform
      if (err.code === "ENOEXEC") {
        console.warn(`  Warning: ${ffmpegPath} is not executable on this platform (ENOEXEC)`);
        resolve(false);
      } else {
        console.warn(`  Warning: Failed to execute ${ffmpegPath}: ${err.message}`);
        resolve(false);
      }
    });
  });
}

/**
 * Main check function
 */
async function main() {
  console.log("FFmpeg Setup Check");
  console.log("==================");
  console.log("");

  const currentPlatformKey = getCurrentPlatform();
  if (!currentPlatformKey) {
    console.error("ERROR: Unsupported platform");
    console.error(`  Platform: ${process.platform}, Arch: ${process.arch}`);
    process.exit(1);
  }

  console.log(`Current platform: ${currentPlatformKey}`);
  console.log("");

  let hasAnyFfmpeg = false;
  let hasBlackmagicFfmpeg = false;
  const results = [];

  // Only check platforms compatible with current environment
  for (const [key, platform] of Object.entries(platforms)) {
    // Skip platforms that are not compatible with current environment
    if (!isPlatformCompatible(key, platform.binaryName)) {
      // Still check if file exists for reporting, but don't test execution
      const exists = checkFfmpeg(platform.name, platform.binaryName);
      results.push({
        platform: platform.name,
        exists: exists,
        hasDeckLink: false,
        path: exists ? path.join(resourcesDir, platform.name, platform.binaryName) : null,
        skipped: true,
        reason: "Not compatible with current platform",
      });
      continue;
    }

    const exists = checkFfmpeg(platform.name, platform.binaryName);
    if (exists) {
      hasAnyFfmpeg = true;
      const ffmpegPath = path.join(
        resourcesDir,
        platform.name,
        platform.binaryName
      );

      // Test DeckLink support only for compatible platforms
      const hasDeckLink = await testDeckLinkSupport(ffmpegPath);
      if (hasDeckLink) {
        hasBlackmagicFfmpeg = true;
      }

      results.push({
        platform: platform.name,
        exists: true,
        hasDeckLink: hasDeckLink,
        path: ffmpegPath,
        skipped: false,
      });
    } else {
      results.push({
        platform: platform.name,
        exists: false,
        hasDeckLink: false,
        path: null,
        skipped: false,
      });
    }
  }

  // Print results
  for (const result of results) {
    if (result.skipped) {
      const status = result.exists ? "Present (skipped - incompatible platform)" : "Missing";
      console.log(`${result.platform}: ${status}`);
    } else if (result.exists) {
      const deckLinkStatus = result.hasDeckLink ? "✓ DeckLink" : "✗ No DeckLink";
      console.log(`${result.platform}: ${deckLinkStatus}`);
    } else {
      console.log(`${result.platform}: Missing`);
    }
  }

  console.log("");

  // Summary
  if (!hasAnyFfmpeg) {
    console.log("⚠ No FFmpeg binaries found.");
    console.log("Run: npm run download:ffmpeg");
    console.log("");
    console.log("Note: This is a warning, not a fatal error.");
    console.log("The build will continue, but ensure FFmpeg is available for production.");
    console.log("");
    // Exit with 0 (success) instead of 1 (error) to allow build to continue
    process.exit(0);
  }

  if (!hasBlackmagicFfmpeg) {
    console.log("⚠ No FFmpeg with DeckLink support found.");
    console.log("SDI output will not work.");
    console.log("See docs/ffmpeg-setup.md for instructions on setting up Blackmagic FFmpeg.");
    console.log("");
    console.log("NDI output will still work with the current FFmpeg builds.");
    process.exit(0);
  }

  console.log("✓ FFmpeg with DeckLink support found!");
  console.log("SDI output is ready.");
  process.exit(0);
}

main();

