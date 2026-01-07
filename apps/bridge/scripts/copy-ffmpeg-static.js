#!/usr/bin/env node

/**
 * Copy ffmpeg-static binary to resources/ffmpeg directory
 * 
 * This script is used as a fallback when system FFmpeg is not available.
 * It copies the platform-specific FFmpeg binary from ffmpeg-static package
 * to the expected location in resources/ffmpeg/<platform>/ffmpeg
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const bridgeDir = path.join(__dirname, "..");
const rootDir = path.join(bridgeDir, "..", "..");
const resourcesDir = path.join(rootDir, "resources", "ffmpeg");

// Determine platform directory
function getPlatformDir() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin") {
    return arch === "arm64" ? "mac-arm64" : "mac-x64";
  } else if (platform === "win32") {
    return "win";
  } else if (platform === "linux") {
    return "linux";
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}

// Get binary name
function getBinaryName() {
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

async function main() {
  try {
    // Try to import ffmpeg-static
    let ffmpegStaticPath;
    try {
      const ffmpegStatic = await import("ffmpeg-static");
      ffmpegStaticPath = ffmpegStatic.default || ffmpegStatic;
    } catch (err) {
      console.error("ERROR: Failed to import ffmpeg-static");
      console.error("Make sure ffmpeg-static is installed: npm install ffmpeg-static");
      process.exit(2);
    }

    if (!ffmpegStaticPath) {
      console.error("ERROR: ffmpeg-static returned empty path");
      process.exit(2);
    }

    const platformDir = getPlatformDir();
    const binaryName = getBinaryName();
    const destDir = path.join(resourcesDir, platformDir);
    const destPath = path.join(destDir, binaryName);

    // Check if destination already exists (don't overwrite system FFmpeg)
    if (fs.existsSync(destPath)) {
      console.log(`FFmpeg already exists at ${destPath}, skipping copy`);
      console.log("This is expected if system FFmpeg was installed.");
      process.exit(0);
    }

    // Check if source exists
    if (!fs.existsSync(ffmpegStaticPath)) {
      console.error(`ERROR: ffmpeg-static binary not found at: ${ffmpegStaticPath}`);
      process.exit(2);
    }

    // Create destination directory
    fs.mkdirSync(destDir, { recursive: true });

    // Copy binary
    console.log(`Copying FFmpeg from ffmpeg-static...`);
    console.log(`  Source: ${ffmpegStaticPath}`);
    console.log(`  Destination: ${destPath}`);
    fs.copyFileSync(ffmpegStaticPath, destPath);

    // Make executable on Unix systems
    if (process.platform !== "win32") {
      fs.chmodSync(destPath, 0o755);
    }

    console.log(`✓ Successfully copied FFmpeg to ${destPath}`);
    process.exit(0);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();

