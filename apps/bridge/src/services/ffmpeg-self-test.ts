import { spawn } from "node:child_process";
import fs from "node:fs";
import { resolveFfmpegPath, getFfmpegInfo } from "../utils/ffmpeg-path.js";

/**
 * Test if FFmpeg has DeckLink support
 *
 * @returns Object with test results
 */
export async function testFfmpegDeckLinkSupport(): Promise<{
  hasSupport: boolean;
  ffmpegPath: string;
  error?: string;
  warning?: string;
}> {
  const ffmpegPath = resolveFfmpegPath();

  return new Promise((resolve) => {
    // Test 1: Check if FFmpeg exists and is executable
    if (ffmpegPath !== "ffmpeg" && !fs.existsSync(ffmpegPath)) {
      resolve({
        hasSupport: false,
        ffmpegPath,
        error: `FFmpeg not found at: ${ffmpegPath}`,
      });
      return;
    }

    // Test 2: Check if FFmpeg supports decklink format
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
      resolve({
        hasSupport: false,
        ffmpegPath,
        error: "FFmpeg DeckLink test timed out",
      });
    }, 5000);

    ffmpegProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpegProcess.on("close", () => {
      clearTimeout(timeout);

      // Check if FFmpeg has DeckLink support
      const hasNoDeckLinkSupport =
        stderr.includes("Unknown input format: decklink") ||
        stderr.includes("No such filter or encoder: decklink") ||
        stderr.includes("Invalid data found when processing input");

      if (hasNoDeckLinkSupport) {
        resolve({
          hasSupport: false,
          ffmpegPath,
          error:
            `FFmpeg at "${ffmpegPath}" does not have DeckLink support. ` +
            `The FFmpeg binary was not compiled with --enable-decklink. ` +
            `Please use a FFmpeg build with DeckLink support (e.g., Blackmagic's FFmpeg build) ` +
            `or compile FFmpeg with --enable-decklink. ` +
            `For SDI output to work, you need FFmpeg with DeckLink support.`,
        });
        return;
      }

      // If we get here, FFmpeg has DeckLink support
      // Check if Blackmagic Desktop Video is installed (macOS specific)
      if (process.platform === "darwin") {
        const bmdFrameworkPath = "/Library/Frameworks/DeckLinkAPI.framework";
        if (!fs.existsSync(bmdFrameworkPath)) {
          resolve({
            hasSupport: true,
            ffmpegPath,
            warning:
              `FFmpeg has DeckLink support, but Blackmagic Desktop Video may not be installed. ` +
              `For DeckLink hardware to work, Blackmagic Desktop Video must be installed. ` +
              `Download from: https://www.blackmagicdesign.com/support`,
          });
          return;
        }
      }

      resolve({
        hasSupport: true,
        ffmpegPath,
      });
    });

    ffmpegProcess.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        hasSupport: false,
        ffmpegPath,
        error:
          `Failed to execute FFmpeg: ${error.message}. ` +
          `FFmpeg path: "${ffmpegPath}". ` +
          `Make sure FFmpeg is installed and accessible.`,
      });
    });
  });
}

/**
 * Log FFmpeg DeckLink support test results
 *
 * Should be called during bridge startup to inform about FFmpeg status.
 */
export async function logFfmpegDeckLinkStatus(logger: {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}): Promise<void> {
  const ffmpegInfo = getFfmpegInfo();
  const testResult = await testFfmpegDeckLinkSupport();

  // Log FFmpeg source
  let sourceInfo = "";
  switch (ffmpegInfo.source) {
    case "env":
      sourceInfo = "Environment variable (FFMPEG_PATH)";
      break;
    case "bundled-blackmagic":
      sourceInfo = "Bundled Blackmagic FFmpeg (DeckLink support expected)";
      break;
    case "bundled-btbn":
      sourceInfo = "Bundled BtbN FFmpeg (DeckLink support unknown)";
      break;
    case "system":
      sourceInfo = "System FFmpeg";
      break;
  }

  logger.info(`[FFmpeg] Source: ${sourceInfo}`);
  logger.info(`[FFmpeg] Path: ${testResult.ffmpegPath}`);

  if (testResult.hasSupport) {
    logger.info(`[FFmpeg] DeckLink support: ✓ Available`);
    if (testResult.warning) {
      logger.warn(`[FFmpeg] ${testResult.warning}`);
    }
  } else {
    logger.error(`[FFmpeg] DeckLink support: ✗ NOT AVAILABLE`);
    if (testResult.error) {
      logger.error(`[FFmpeg] ${testResult.error}`);
    }

    // Provide specific guidance based on source
    if (ffmpegInfo.source === "bundled-btbn") {
      logger.warn(
        `[FFmpeg] The bundled BtbN FFmpeg does not have DeckLink support. ` +
          `For SDI output, you need Blackmagic FFmpeg with DeckLink support. ` +
          `See docs/ffmpeg-setup.md for instructions.`
      );
    } else if (ffmpegInfo.source === "system") {
      logger.warn(
        `[FFmpeg] System FFmpeg does not have DeckLink support. ` +
          `For SDI output, use Blackmagic FFmpeg or set FFMPEG_PATH to a FFmpeg with DeckLink support.`
      );
    } else {
      logger.warn(
        `[FFmpeg] SDI output will not work without FFmpeg DeckLink support. ` +
          `NDI output will still work.`
      );
    }
  }
}
