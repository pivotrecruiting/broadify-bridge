#!/usr/bin/env node

/**
 * Download cloudflared binaries for all platforms
 * Downloads the latest release from GitHub and extracts platform-specific binaries
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");
const resourcesDir = path.join(rootDir, "resources", "cloudflared");

// Platform mappings with search patterns
const platforms = {
  "darwin-arm64": {
    name: "mac-arm64",
    searchPatterns: ["darwin-arm64", "darwin-arm"],
    binaryName: "cloudflared",
  },
  "darwin-x64": {
    name: "mac-x64",
    searchPatterns: ["darwin-amd64", "darwin-x64"],
    binaryName: "cloudflared",
  },
  "win32-x64": {
    name: "win",
    searchPatterns: ["windows-amd64.exe", "windows-x64.exe"],
    binaryName: "cloudflared.exe",
  },
  "linux-x64": {
    name: "linux",
    searchPatterns: ["cloudflared-linux-amd64", "linux-amd64", "linux-x64"],
    binaryName: "cloudflared",
    excludePatterns: ["fips"], // Prefer standard version over FIPS
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
    const options = {
      hostname: "api.github.com",
      path: "/repos/cloudflare/cloudflared/releases/latest",
      headers: {
        "User-Agent": "broadify-bridge-v2",
      },
    };

    https
      .get(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
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
 * Find asset URL and name for a platform using search patterns
 */
function findAsset(release, searchPatterns, excludePatterns = []) {
  // First, try to find an asset that matches any of the patterns and doesn't match exclude patterns
  for (const pattern of searchPatterns) {
    const asset = release.assets.find((a) => {
      const nameLower = a.name.toLowerCase();
      const matchesPattern = nameLower.includes(pattern.toLowerCase());
      const matchesExclude = excludePatterns.some((exclude) =>
        nameLower.includes(exclude.toLowerCase())
      );
      return matchesPattern && !matchesExclude;
    });
    if (asset) {
      return { url: asset.browser_download_url, name: asset.name };
    }
  }

  // If no match found (excluding patterns), try again without exclusions as fallback
  if (excludePatterns.length > 0) {
    for (const pattern of searchPatterns) {
      const asset = release.assets.find((a) =>
        a.name.toLowerCase().includes(pattern.toLowerCase())
      );
      if (asset) {
        console.warn(
          `  Warning: Using fallback asset ${asset.name} (excluded patterns were preferred but not found)`
        );
        return { url: asset.browser_download_url, name: asset.name };
      }
    }
  }

  // If no match found, list available assets for debugging
  const availableAssets = release.assets.map((a) => a.name).join(", ");
  throw new Error(
    `Asset not found for patterns [${searchPatterns.join(
      ", "
    )}]. Available assets: ${availableAssets}`
  );
}

/**
 * Extract binary from archive if needed
 */
function extractBinary(archivePath, destPath, binaryName) {
  const archiveExt = path.extname(archivePath).toLowerCase();

  if (archiveExt === ".tgz" || archiveExt === ".tar.gz") {
    // Extract from tar.gz
    const tempDir = path.join(path.dirname(archivePath), "temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    try {
      // Extract archive
      execSync(`tar -xzf "${archivePath}" -C "${tempDir}"`, {
        stdio: "ignore",
      });

      // Find the binary in the extracted files
      const findBinary = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = findBinary(fullPath);
            if (found) return found;
          } else if (
            entry.name === binaryName ||
            entry.name === "cloudflared"
          ) {
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
  } else if (archiveExt === ".zip") {
    // Extract from zip (Windows)
    const tempDir = path.join(path.dirname(archivePath), "temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    try {
      // Extract archive (requires unzip command)
      execSync(`unzip -q "${archivePath}" -d "${tempDir}"`, {
        stdio: "ignore",
      });

      // Find the binary
      const findBinary = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = findBinary(fullPath);
            if (found) return found;
          } else if (
            entry.name === binaryName ||
            entry.name === "cloudflared.exe"
          ) {
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
  } else {
    // No extraction needed, just copy
    if (archivePath !== destPath) {
      fs.copyFileSync(archivePath, destPath);
      fs.unlinkSync(archivePath);
    }
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
 * Main download function
 */
async function main() {
  console.log("Downloading cloudflared binaries...");

  // Create resources directory structure
  for (const platform of Object.values(platforms)) {
    const platformDir = path.join(resourcesDir, platform.name);
    if (!fs.existsSync(platformDir)) {
      fs.mkdirSync(platformDir, { recursive: true });
    }
  }

  try {
    // Get latest release
    console.log("Fetching latest cloudflared release...");
    const release = await getLatestRelease();
    console.log(`Latest version: ${release.tag_name}`);

    // Download binaries for each platform
    for (const [key, platform] of Object.entries(platforms)) {
      const destPath = path.join(
        resourcesDir,
        platform.name,
        platform.binaryName
      );

      // Skip if already exists (for faster rebuilds)
      if (fs.existsSync(destPath)) {
        console.log(`Skipping ${platform.name} (already exists)`);
        continue;
      }

      try {
        console.log(`Downloading ${platform.name}...`);
        const asset = findAsset(
          release,
          platform.searchPatterns,
          platform.excludePatterns || []
        );
        console.log(`  Found asset: ${asset.name}`);

        // Download to temporary location first
        const tempPath = path.join(resourcesDir, platform.name, asset.name);
        await downloadFile(asset.url, tempPath);

        // Extract binary if needed
        extractBinary(tempPath, destPath, platform.binaryName);

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

    console.log("\n✓ All cloudflared binaries downloaded successfully!");
    console.log(`Location: ${resourcesDir}`);
  } catch (err) {
    console.error(`\n✗ Error: ${err.message}`);
    process.exit(1);
  }
}

main();
