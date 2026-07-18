const { access } = require("node:fs/promises");
const path = require("node:path");

const WINDOWS_NATIVE_RESOURCES = Object.freeze([
  "resources/native/display-helper/display-helper.exe",
  "resources/native/display-helper/SDL2.dll",
  "resources/native/meeting-helper/meeting-helper.exe",
  "resources/native/meeting-helper/onnxruntime.dll",
  "resources/native/meeting-helper/onnxruntime_providers_shared.dll",
  "resources/native/meeting-helper/DirectML.dll",
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
