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
    const process = spawn(ffmpegPath, [
      "-f",
      "decklink",
      "-list_devices",
      "1",
      "-i",
      "dummy",
    ]);

    let stderr = "";
    const timeout = setTimeout(() => {
      process.kill("SIGTERM");
      resolve(false);
    }, 3000);

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", () => {
      clearTimeout(timeout);
      const hasNoSupport =
        stderr.includes("Unknown input format: decklink") ||
        stderr.includes("No such filter or encoder: decklink");
      resolve(!hasNoSupport);
    });

    process.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
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

  let hasAnyFfmpeg = false;
  let hasBlackmagicFfmpeg = false;
  const results = [];

  for (const [key, platform] of Object.entries(platforms)) {
    const exists = checkFfmpeg(platform.name, platform.binaryName);
    if (exists) {
      hasAnyFfmpeg = true;
      const ffmpegPath = path.join(
        resourcesDir,
        platform.name,
        platform.binaryName
      );

      // Test DeckLink support
      const hasDeckLink = await testDeckLinkSupport(ffmpegPath);
      if (hasDeckLink) {
        hasBlackmagicFfmpeg = true;
      }

      results.push({
        platform: platform.name,
        exists: true,
        hasDeckLink: hasDeckLink,
        path: ffmpegPath,
      });
    } else {
      results.push({
        platform: platform.name,
        exists: false,
        hasDeckLink: false,
        path: null,
      });
    }
  }

  // Print results
  for (const result of results) {
    if (result.exists) {
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
    process.exit(1);
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

