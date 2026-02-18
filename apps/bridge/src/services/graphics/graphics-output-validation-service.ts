import type { GraphicsOutputKeyT, GraphicsTargetsT } from "./graphics-schemas.js";
import { getBridgeContext } from "../bridge-context.js";
import { deviceCache } from "../device-cache.js";
import { listDecklinkDisplayModes } from "../../modules/decklink/decklink-helper.js";
import {
  KEY_FILL_PIXEL_FORMAT_PRIORITY,
  VIDEO_PIXEL_FORMAT_PRIORITY,
  supportsAnyPixelFormat,
} from "./output-format-policy.js";
import { findDevicePort } from "./graphics-device-port-resolver.js";

/**
 * Validate that output targets are consistent with the selected output mode.
 *
 * @param outputKey Selected output mode.
 * @param targets Selected output targets.
 */
export async function validateOutputTargets(
  outputKey: GraphicsOutputKeyT,
  targets: GraphicsTargetsT
): Promise<void> {
  if (outputKey === "key_fill_sdi") {
    if (!targets.output1Id || !targets.output2Id) {
      throw new Error("Output 1 and Output 2 are required for Key & Fill SDI");
    }
    if (targets.output1Id === targets.output2Id) {
      throw new Error("Output 1 and Output 2 must be different");
    }

    const devices = await deviceCache.getDevices();
    const output1Match = findDevicePort(devices, targets.output1Id);
    const output2Match = findDevicePort(devices, targets.output2Id);
    if (!output1Match || !output2Match) {
      throw new Error("Invalid output ports selected");
    }
    if (output1Match.device.id !== output2Match.device.id) {
      throw new Error("Output ports must belong to the same device");
    }
    if (output1Match.port.type !== "sdi" || output2Match.port.type !== "sdi") {
      throw new Error("Key & Fill SDI requires SDI output ports");
    }
    if (output1Match.port.role !== "fill") {
      throw new Error("Output 1 must be the SDI Fill port");
    }
    if (output2Match.port.role !== "key") {
      throw new Error("Output 2 must be the SDI Key port");
    }
    if (!output1Match.port.status.available || !output2Match.port.status.available) {
      throw new Error("Selected output ports are not available");
    }
  }

  if (outputKey === "video_sdi") {
    if (!targets.output1Id) {
      throw new Error("Output 1 is required for Video SDI");
    }
    const devices = await deviceCache.getDevices();
    const output1Match = findDevicePort(devices, targets.output1Id);
    if (!output1Match) {
      throw new Error("Invalid output port selected");
    }
    if (output1Match.port.type !== "sdi") {
      throw new Error("Video SDI requires an SDI output port");
    }
    if (output1Match.port.role === "key") {
      throw new Error("Video SDI cannot use the SDI Key port");
    }
    if (!output1Match.port.status.available) {
      throw new Error("Selected output port is not available");
    }
  }

  if (outputKey === "video_hdmi") {
    if (!targets.output1Id) {
      throw new Error("Output 1 is required for Video HDMI");
    }
    const devices = await deviceCache.getDevices();
    const output1Match = findDevicePort(devices, targets.output1Id);
    if (!output1Match) {
      throw new Error("Invalid output port selected");
    }
    if (
      output1Match.port.type !== "hdmi" &&
      output1Match.port.type !== "displayport" &&
      output1Match.port.type !== "thunderbolt"
    ) {
      throw new Error(
        "Video HDMI requires an HDMI/DisplayPort/Thunderbolt output port"
      );
    }
    if (!output1Match.port.status.available) {
      throw new Error("Selected output port is not available");
    }
  }
}

/**
 * Validate output video format against selected target capabilities.
 *
 * @param outputKey Selected output mode.
 * @param targets Selected output targets.
 * @param format Requested output format.
 */
export async function validateOutputFormat(
  outputKey: GraphicsOutputKeyT,
  targets: GraphicsTargetsT,
  format: { width: number; height: number; fps: number }
): Promise<void> {
  if (outputKey === "stub" || outputKey === "key_fill_ndi") {
    return;
  }

  const outputIds = [targets.output1Id];
  const devices = await deviceCache.getDevices();
  const requireKeying = outputKey === "key_fill_sdi";
  const preferredFormats =
    outputKey === "key_fill_sdi"
      ? KEY_FILL_PIXEL_FORMAT_PRIORITY
      : VIDEO_PIXEL_FORMAT_PRIORITY;

  for (const outputId of outputIds) {
    if (!outputId) {
      continue;
    }
    const outputMatch = findDevicePort(devices, outputId);
    if (!outputMatch) {
      continue;
    }

    if (outputMatch.device.type === "display") {
      const modes = outputMatch.port.capabilities.modes ?? [];
      if (modes.length === 0) {
        getBridgeContext().logger.warn(
          `[Graphics] Display output has no mode list; skipping format validation for ${outputId}`
        );
        continue;
      }
      const hasMatch = modes.some(
        (mode) =>
          mode.width === format.width &&
          mode.height === format.height &&
          Math.abs(mode.fps - format.fps) < 0.01
      );
      if (!hasMatch) {
        throw new Error("Output format not supported by selected display");
      }
      continue;
    }

    if (outputMatch.device.type !== "decklink") {
      continue;
    }

    const modes = await listDecklinkDisplayModes(outputMatch.device.id, outputId, {
      width: format.width,
      height: format.height,
      fps: format.fps,
      requireKeying,
    });

    if (modes.length === 0) {
      throw new Error("Output format not supported by selected device");
    }

    const hasSupportedFormat = modes.some((mode) =>
      supportsAnyPixelFormat(mode.pixelFormats, preferredFormats)
    );

    if (!hasSupportedFormat) {
      throw new Error("Output pixel format not supported by selected device");
    }
  }
}
