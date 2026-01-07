#!/usr/bin/env node

/**
 * Download FFmpeg static builds for all platforms
 * 
 * Strategy:
 * 1. Check if Blackmagic FFmpeg is manually placed (has DeckLink support)
 * 2. If not, download BtbN FFmpeg Builds (for NDI, may not have DeckLink support)
 * 
 * Note: For SDI output, Blackmagic FFmpeg with DeckLink support is required.
 * See docs/ffmpeg-setup.md for instructions on how to obtain and place Blackmagic FFmpeg.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");
const resourcesDir = path.join(rootDir, "resources", "ffmpeg");

// Platform mappings for FFmpeg static builds
// Using BtbN FFmpeg Builds (https://github.com/BtbN/FFmpeg-Builds)
const platforms = {
  "darwin-arm64": {
    name: "mac-arm64",
    searchPatterns: ["ffmpeg-master-latest-darwinarm64"],
    binaryName: "ffmpeg",
    archiveExt: ".zip",
  },
  "darwin-x64": {
    name: "mac-x64",
    searchPatterns: ["ffmpeg-master-latest-darwin64"],
    binaryName: "ffmpeg",
    archiveExt: ".zip",
  },
  "win32-x64": {
    name: "win",
    searchPatterns: ["ffmpeg-master-latest-win64-gpl"],
    binaryName: "ffmpeg.exe",
    archiveExt: ".zip",
  },
  "linux-x64": {
    name: "linux",
    searchPatterns: ["ffmpeg-master-latest-linux64-gpl"],
    binaryName: "ffmpeg",
    archiveExt: ".tar.xz",
  },
};

/**
 * Download a file from URL
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // Follow redirect
          return downloadFile(response.headers.location, dest)
            .then(resolve)
            .catch(reject);
        }
        if (response.statusCode !== 200) {
          reject(
            new Error(`Failed to download: ${response.statusCode} ${url}`)
          );
          return;
        }
        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

/**
 * Get latest release info from GitHub API
 */
async function getLatestRelease() {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent": "broadify-bridge-v2",
    };

    const githubToken = process.env.GITHUB_TOKEN;
    if (githubToken) {
      headers["Authorization"] = `Bearer ${githubToken}`;
    }

    const options = {
      hostname: "api.github.com",
      path: "/repos/BtbN/FFmpeg-Builds/releases/latest",
      headers,
    };

    https
      .get(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(`GitHub API returned status ${res.statusCode}`)
            );
            return;
          }

          try {
            const release = JSON.parse(data);
            resolve(release);
          } catch (err) {
            reject(new Error(`Failed to parse release data: ${err.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

/**
 * Find asset URL for a platform
 */
function findAsset(release, searchPatterns) {
  if (!release.assets || !Array.isArray(release.assets)) {
    throw new Error("Release data missing required 'assets' field");
  }

  for (const pattern of searchPatterns) {
    const asset = release.assets.find((a) =>
      a.name.toLowerCase().includes(pattern.toLowerCase())
    );
    if (asset) {
      return { url: asset.browser_download_url, name: asset.name };
    }
  }

  const availableAssets = release.assets.map((a) => a.name).join(", ");
  throw new Error(
    `Asset not found for patterns [${searchPatterns.join(
      ", "
    )}]. Available assets: ${availableAssets}`
  );
}

/**
 * Extract binary from archive
 */
function extractBinary(archivePath, destPath, binaryName, archiveExt) {
  const tempDir = path.join(path.dirname(archivePath), "temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  try {
    if (archiveExt === ".zip") {
      execSync(`unzip -q "${archivePath}" -d "${tempDir}"`, {
        stdio: "ignore",
      });
    } else if (archiveExt === ".tar.xz") {
      execSync(`tar -xJf "${archivePath}" -C "${tempDir}"`, {
        stdio: "ignore",
      });
    } else {
      throw new Error(`Unsupported archive format: ${archiveExt}`);
    }

    // Find the binary (FFmpeg is usually in a subdirectory like "ffmpeg-master-latest-.../bin/ffmpeg")
    const findBinary = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = findBinary(fullPath);
          if (found) return found;
        } else if (entry.name === binaryName) {
          return fullPath;
        }
      }
      return null;
    };

    const binaryPath = findBinary(tempDir);
    if (!binaryPath) {
      throw new Error(`Binary ${binaryName} not found in archive`);
    }

    // Copy to destination
    fs.copyFileSync(binaryPath, destPath);

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.unlinkSync(archivePath);
  } catch (err) {
    // Cleanup on error
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    throw err;
  }
}

/**
 * Make file executable (Unix only)
 */
function makeExecutable(filePath) {
  try {
    execSync(`chmod +x "${filePath}"`, { stdio: "ignore" });
  } catch (err) {
    // Ignore errors on Windows
  }
}

/**
 * Check if Blackmagic FFmpeg is manually placed
 */
function checkBlackmagicFfmpeg(platformName, binaryName) {
  const destPath = path.join(resourcesDir, platformName, binaryName);
  return fs.existsSync(destPath);
}

/**
 * Download BtbN FFmpeg builds (fallback, may not have DeckLink support)
 */
async function downloadBtbNFfmpeg() {
  console.log("Downloading BtbN FFmpeg builds (fallback for NDI)...");
  console.log(
    "Note: These builds may not have DeckLink support. For SDI output, use Blackmagic FFmpeg."
  );

  // Create resources directory structure
  for (const platform of Object.values(platforms)) {
    const platformDir = path.join(resourcesDir, platform.name);
    if (!fs.existsSync(platformDir)) {
      fs.mkdirSync(platformDir, { recursive: true });
    }
  }

  try {
    // Get latest release
    console.log("Fetching latest BtbN FFmpeg release...");
    const release = await getLatestRelease();
    console.log(`Latest version: ${release.tag_name}`);

    // Download binaries for each platform
    for (const [key, platform] of Object.entries(platforms)) {
      const destPath = path.join(
        resourcesDir,
        platform.name,
        platform.binaryName
      );

      // Skip if Blackmagic FFmpeg already exists
      if (checkBlackmagicFfmpeg(platform.name, platform.binaryName)) {
        console.log(
          `Skipping ${platform.name} (Blackmagic FFmpeg already present)`
        );
        continue;
      }

      // Skip if already exists (for faster rebuilds)
      if (fs.existsSync(destPath)) {
        console.log(`Skipping ${platform.name} (already exists)`);
        continue;
      }

      try {
        console.log(`Downloading ${platform.name}...`);
        const asset = findAsset(release, platform.searchPatterns);
        console.log(`  Found asset: ${asset.name}`);

        // Download to temporary location first
        const tempPath = path.join(resourcesDir, platform.name, asset.name);
        await downloadFile(asset.url, tempPath);

        // Extract binary if needed
        extractBinary(
          tempPath,
          destPath,
          platform.binaryName,
          platform.archiveExt
        );

        // Make executable on Unix systems
        if (process.platform !== "win32") {
          makeExecutable(destPath);
        }

        console.log(`✓ Downloaded ${platform.name}`);
      } catch (err) {
        console.error(`✗ Failed to download ${platform.name}: ${err.message}`);
        throw err;
      }
    }

    console.log("\n✓ All FFmpeg binaries downloaded successfully!");
    console.log(`Location: ${resourcesDir}`);
  } catch (err) {
    console.error(`\n✗ Error: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Main download function
 */
async function main() {
  console.log("FFmpeg Download Script");
  console.log("======================");
  console.log("");

  // Check for Blackmagic FFmpeg
  let hasBlackmagicFfmpeg = false;
  const blackmagicPlatforms = [];

  for (const [key, platform] of Object.entries(platforms)) {
    if (checkBlackmagicFfmpeg(platform.name, platform.binaryName)) {
      hasBlackmagicFfmpeg = true;
      blackmagicPlatforms.push(platform.name);
      console.log(
        `✓ Found Blackmagic FFmpeg for ${platform.name} (has DeckLink support)`
      );
    }
  }

  if (hasBlackmagicFfmpeg) {
    console.log("");
    console.log(
      "Blackmagic FFmpeg detected! This has DeckLink support for SDI output."
    );
    console.log(
      "Missing platforms will use BtbN FFmpeg (may not have DeckLink support)."
    );
    console.log("");
  } else {
    console.log("");
    console.log("⚠ No Blackmagic FFmpeg found.");
    console.log(
      "For SDI output, you need FFmpeg with DeckLink support."
    );
    console.log(
      "See docs/ffmpeg-setup.md for instructions on how to obtain Blackmagic FFmpeg."
    );
    console.log("");
    console.log(
      "Downloading BtbN FFmpeg builds (fallback for NDI, may not have DeckLink support)..."
    );
    console.log("");
  }

  // Download BtbN builds for missing platforms
  await downloadBtbNFfmpeg();

  // Final summary
  console.log("");
  console.log("Summary:");
  for (const [key, platform] of Object.entries(platforms)) {
    const destPath = path.join(
      resourcesDir,
      platform.name,
      platform.binaryName
    );
    if (fs.existsSync(destPath)) {
      const isBlackmagic = checkBlackmagicFfmpeg(
        platform.name,
        platform.binaryName
      );
      const source = isBlackmagic ? "Blackmagic (DeckLink ✓)" : "BtbN (DeckLink ?)";
      console.log(`  ${platform.name}: ${source}`);
    } else {
      console.log(`  ${platform.name}: Missing`);
    }
  }
}

main();

