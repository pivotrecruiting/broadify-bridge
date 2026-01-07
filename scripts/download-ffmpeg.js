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
// Alternative source for mac-arm64: Martin Riedl Builds (https://evermeet.cx/ffmpeg/)
const platforms = {
  "darwin-arm64": {
    name: "mac-arm64",
    searchPatterns: ["ffmpeg-master-latest-darwinarm64"],
    binaryName: "ffmpeg",
    archiveExt: ".zip",
    alternativeSource: {
      url: "https://evermeet.cx/ffmpeg/ffmpeg.zip",
      name: "ffmpeg-martin-riedl-arm64.zip",
    },
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
 * Returns null if asset is not found (graceful handling)
 */
function findAsset(release, searchPatterns) {
  if (!release.assets || !Array.isArray(release.assets)) {
    return null;
  }

  for (const pattern of searchPatterns) {
    const asset = release.assets.find((a) =>
      a.name.toLowerCase().includes(pattern.toLowerCase())
    );
    if (asset) {
      return { url: asset.browser_download_url, name: asset.name };
    }
  }

  return null;
}

/**
 * Extract binary from archive
 * 
 * Platform-specific extraction:
 * - Windows: Uses PowerShell Expand-Archive
 * - Unix: Uses unzip/tar commands
 */
function extractBinary(archivePath, destPath, binaryName, archiveExt) {
  const tempDir = path.join(path.dirname(archivePath), "temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Ensure destination directory exists
  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  try {
    console.log(`  Extracting archive: ${path.basename(archivePath)}`);
    
    if (archiveExt === ".zip") {
      if (process.platform === "win32") {
        // Use PowerShell Expand-Archive on Windows
        const normalizedArchivePath = archivePath.replace(/\\/g, "/");
        const normalizedTempDir = tempDir.replace(/\\/g, "/");
        execSync(
          `powershell -Command "Expand-Archive -Path '${normalizedArchivePath}' -DestinationPath '${normalizedTempDir}' -Force"`,
          { stdio: "inherit" }
        );
      } else {
        // Use unzip on Unix systems
        execSync(`unzip -q "${archivePath}" -d "${tempDir}"`, {
          stdio: "ignore",
        });
      }
    } else if (archiveExt === ".tar.xz") {
      // tar is available on both Unix and Windows (via Git Bash or WSL)
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

    console.log(`  Searching for binary: ${binaryName}`);
    const binaryPath = findBinary(tempDir);
    if (!binaryPath) {
      throw new Error(`Binary ${binaryName} not found in archive`);
    }

    console.log(`  Found binary at: ${binaryPath}`);
    console.log(`  Copying to: ${destPath}`);

    // Copy to destination
    fs.copyFileSync(binaryPath, destPath);

    // Verify the copy was successful
    if (!fs.existsSync(destPath)) {
      throw new Error(`Failed to copy binary to ${destPath}`);
    }

    const stats = fs.statSync(destPath);
    if (stats.size === 0) {
      throw new Error(`Copied binary is empty: ${destPath}`);
    }

    console.log(`  ✓ Successfully extracted and copied binary (${stats.size} bytes)`);

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.unlinkSync(archivePath);
  } catch (err) {
    // Cleanup on error
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    console.error(`  ✗ Extraction failed: ${err.message}`);
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
 * Download FFmpeg from alternative source (e.g., Martin Riedl for mac-arm64)
 */
async function downloadFromAlternativeSource(platform, destPath) {
  if (!platform.alternativeSource) {
    return false;
  }

  try {
    console.log(`  Trying alternative source: ${platform.alternativeSource.url}`);
    const tempPath = path.join(
      resourcesDir,
      platform.name,
      platform.alternativeSource.name
    );
    await downloadFile(platform.alternativeSource.url, tempPath);

    // Extract binary
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

    console.log(`  ✓ Downloaded from alternative source`);
    return true;
  } catch (err) {
    console.log(`  ✗ Alternative source failed: ${err.message}`);
    return false;
  }
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

  let release = null;
  let hasErrors = false;
  const failedPlatforms = [];

  try {
    // Get latest release
    console.log("Fetching latest BtbN FFmpeg release...");
    release = await getLatestRelease();
    console.log(`Latest version: ${release.tag_name}`);
  } catch (err) {
    console.warn(`⚠ Failed to fetch BtbN release: ${err.message}`);
    console.warn("  Continuing with alternative sources where available...");
  }

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
      let downloaded = false;

      // Try BtbN release first (if available)
      if (release) {
        const asset = findAsset(release, platform.searchPatterns);
        if (asset) {
          console.log(`  Found asset: ${asset.name}`);

          // Download to temporary location first
          const tempPath = path.join(resourcesDir, platform.name, asset.name);
          await downloadFile(asset.url, tempPath);

              // Extract binary if needed
          try {
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

            // Verify the binary exists and is valid
            if (!fs.existsSync(destPath)) {
              throw new Error(`Binary not found at destination: ${destPath}`);
            }

            const stats = fs.statSync(destPath);
            if (stats.size === 0) {
              throw new Error(`Binary is empty: ${destPath}`);
            }

            console.log(`✓ Downloaded ${platform.name} from BtbN`);
            downloaded = true;
          } catch (extractErr) {
            console.error(`  ✗ Extraction failed: ${extractErr.message}`);
            // Clean up partial download
            if (fs.existsSync(tempPath)) {
              fs.unlinkSync(tempPath);
            }
            throw extractErr;
          }
        }
      }

      // Try alternative source if BtbN failed
      if (!downloaded && platform.alternativeSource) {
        downloaded = await downloadFromAlternativeSource(platform, destPath);
        if (downloaded) {
          console.log(`✓ Downloaded ${platform.name} from alternative source`);
        }
      }

      // If still not downloaded, warn but don't fail
      if (!downloaded) {
        const availableAssets = release
          ? release.assets.map((a) => a.name).join(", ")
          : "N/A (release fetch failed)";
        console.warn(
          `⚠ Could not download ${platform.name} from BtbN or alternative source`
        );
        console.warn(
          `  Searched for patterns: ${platform.searchPatterns.join(", ")}`
        );
        if (release) {
          console.warn(`  Available assets: ${availableAssets}`);
        }
        console.warn(
          `  You can manually place Blackmagic FFmpeg at: ${destPath}`
        );
        console.warn(
          `  See docs/ffmpeg-setup.md for instructions.`
        );
        hasErrors = true;
        failedPlatforms.push(platform.name);
      }
    } catch (err) {
      console.error(`⚠ Failed to download ${platform.name}: ${err.message}`);
      if (err.stack) {
        console.error(`  Stack trace: ${err.stack.split('\n').slice(1, 3).join('\n')}`);
      }
      console.warn(
        `  You can manually place Blackmagic FFmpeg at: ${destPath}`
      );
      hasErrors = true;
      failedPlatforms.push(platform.name);
    }
  }

  // Summary
  if (hasErrors) {
    console.log("\n⚠ Some FFmpeg binaries could not be downloaded:");
    for (const platform of failedPlatforms) {
      console.log(`  - ${platform}`);
    }
    console.log(
      "\n  This is not a fatal error. The build will continue."
    );
    console.log(
      "  For production, ensure FFmpeg is available (manually placed or via alternative source)."
    );
  } else {
    console.log("\n✓ All FFmpeg binaries downloaded successfully!");
  }
  console.log(`Location: ${resourcesDir}`);
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
  let allPresent = true;
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
      const source = isBlackmagic ? "Blackmagic (DeckLink ✓)" : "BtbN/Alternative (DeckLink ?)";
      console.log(`  ${platform.name}: ${source}`);
    } else {
      console.log(`  ${platform.name}: Missing`);
      allPresent = false;
    }
  }

  // Exit with warning code if some are missing, but don't fail the build
  if (!allPresent) {
    console.log("");
    console.log("⚠ Some FFmpeg binaries are missing.");
    console.log("  The build will continue, but ensure FFmpeg is available for production.");
    process.exit(0); // Exit 0 = success, but with warnings
  }
}

main();

