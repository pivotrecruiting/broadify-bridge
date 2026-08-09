const { access } = require("node:fs/promises");
const path = require("node:path");

const WINDOWS_NATIVE_RESOURCES = Object.freeze([
  "resources/native/display-helper/display-helper.exe",
  "resources/native/display-helper/SDL2.dll",
  "resources/native/meeting-helper/meeting-helper.exe",
  "resources/native/meeting-helper/onnxruntime.dll",
  "resources/native/meeting-helper/onnxruntime_providers_shared.dll",
  "resources/native/meeting-helper/DirectML.dll",
  // OpenVINO runtime for the Windows matting backend (cache.json is data,
  // not a PE file, and is packaged unsigned). Keep in sync with
  // electron-builder.config.cjs and scripts/prepare-windows-openvino-deps.ps1.
  "resources/native/meeting-helper/openvino.dll",
  "resources/native/meeting-helper/openvino_auto_batch_plugin.dll",
  "resources/native/meeting-helper/openvino_auto_plugin.dll",
  "resources/native/meeting-helper/openvino_hetero_plugin.dll",
  "resources/native/meeting-helper/openvino_intel_cpu_plugin.dll",
  "resources/native/meeting-helper/openvino_intel_gpu_plugin.dll",
  "resources/native/meeting-helper/openvino_intel_npu_plugin.dll",
  "resources/native/meeting-helper/openvino_ir_frontend.dll",
  "resources/native/meeting-helper/openvino_onnx_frontend.dll",
  "resources/native/meeting-helper/tbb12.dll",
  "resources/native/meeting-helper/tbbbind_2_5.dll",
  "resources/native/meeting-helper/tbbmalloc.dll",
  "resources/native/vcam-helper/broadify-vcam.dll",
]);

function getWindowsNativeResourcePaths(appOutDir) {
  return WINDOWS_NATIVE_RESOURCES.map((relativePath) =>
    path.join(appOutDir, ...relativePath.split("/")),
  );
}

async function signWindowsNativeResources(context) {
  if (
    context.electronPlatformName !== "win32" ||
    !context.packager.platformSpecificBuildOptions?.azureSignOptions
  ) {
    return;
  }

  const files = getWindowsNativeResourcePaths(context.appOutDir);
  for (const file of files) {
    await access(file);
    console.log(`[Signing] Signing packaged native resource: ${file}`);
    const signed = await context.packager.sign(file);
    if (!signed) {
      throw new Error(`Windows native resource was not signed: ${file}`);
    }
  }
}

module.exports = signWindowsNativeResources;
module.exports.getWindowsNativeResourcePaths = getWindowsNativeResourcePaths;
module.exports.WINDOWS_NATIVE_RESOURCES = WINDOWS_NATIVE_RESOURCES;
