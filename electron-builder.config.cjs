const baseConfig = require("./electron-builder.json");

const config = JSON.parse(JSON.stringify(baseConfig));
const updaterChannel =
  typeof process.env.BROADIFY_UPDATER_CHANNEL === "string" &&
  process.env.BROADIFY_UPDATER_CHANNEL.trim() !== ""
    ? process.env.BROADIFY_UPDATER_CHANNEL.trim()
    : "latest";
const isRcChannel = updaterChannel === "rc";

const MAC_ONLY_NATIVE_RESOURCES = new Set([
  "apps/bridge/native/decklink-helper/decklink-helper",
  "apps/bridge/native/display-helper/display-helper",
  "apps/bridge/native/display-helper/libSDL2-2.0.0.dylib",
  "apps/bridge/native/meeting-helper/Broadify Bridge Meeting Helper.app",
  "apps/bridge/native/vcam-helper/build/Release/BroadifyVCam.app",
]);
const BRIDGE_NODE_MODULES_DEV_EXCLUDES = [
  "!**/.bin{,/**}",
  "!**/@esbuild{,/**}",
  "!**/esbuild{,/**}",
  "!**/tsx{,/**}",
  "!**/typescript{,/**}",
  "!**/@types{,/**}",
];
const PRESENTATION_RUNTIME_PATH =
  "apps/bridge/vendor/presentation-runtime/macos-arm64";

const argValues = process.argv.flatMap((arg, index, args) => {
  const values = [arg];
  if (
    ["--arch", "-a", "--mac"].includes(arg) &&
    typeof args[index + 1] === "string"
  ) {
    values.push(args[index + 1]);
  }
  return values;
});
const requestedArchValues = [
  ...argValues,
  process.env.npm_config_arch,
  process.env.ARCH,
  process.env.CSC_ARCH,
  process.env.ELECTRON_BUILDER_ARCH,
].filter((value) => typeof value === "string");
const hasRequestedArch = (arch) =>
  requestedArchValues.some((value) =>
    new RegExp(`(^|[=,\\s-])${arch}($|[,\\s])`).test(value),
  );
const targetsAppleSilicon = hasRequestedArch("arm64");
const targetsIntelMac = hasRequestedArch("x64");
const includesAppleSiliconPresentationRuntime =
  targetsAppleSilicon ||
  (!targetsIntelMac && process.platform === "darwin" && process.arch === "arm64");

if (isRcChannel) {
  config.appId = "com.broadify.bridge.rc";
  config.productName = "Broadify Bridge RC";
}

// Keep macOS-only helper binaries out of Windows/Linux packaging to avoid missing-file warnings.
const macOnlyResources = (config.extraResources || []).filter((entry) =>
  MAC_ONLY_NATIVE_RESOURCES.has(entry.from),
);

config.extraResources = (config.extraResources || []).filter(
  (entry) => !MAC_ONLY_NATIVE_RESOURCES.has(entry.from),
);

config.extraResources = (config.extraResources || []).map((entry) => {
  if (entry.from !== "apps/bridge/node_modules") {
    return entry;
  }

  return {
    ...entry,
    filter: ["**/*", ...BRIDGE_NODE_MODULES_DEV_EXCLUDES],
  };
});

config.mac = config.mac || {};
config.mac.extraResources = [
  ...(config.mac.extraResources || []),
  ...macOnlyResources,
];

if (includesAppleSiliconPresentationRuntime) {
  config.mac.extraResources.push({
    from: PRESENTATION_RUNTIME_PATH,
    to: "presentation-runtime/macos-arm64",
    filter: ["**/*"],
  });
}

// Keep artifact names deterministic so the published release assets match
// the filenames referenced inside the generated updater metadata.
if (!config.artifactName) {
  config.artifactName = isRcChannel
    ? "Broadify-Bridge-RC-${version}-${arch}.${ext}"
    : "Broadify-Bridge-${version}-${arch}.${ext}";
}

config.generateUpdatesFilesForAllChannels = true;

if (Array.isArray(config.publish)) {
  config.publish = config.publish.map((entry) => ({
    ...entry,
    channel: updaterChannel,
  }));
}

if (config.win) {
  config.win.signExts = [".dll"];
  config.win.extraResources = [
    ...(config.win.extraResources || []),
    {
      from: "apps/bridge/native/display-helper/display-helper.exe",
      to: "native/display-helper/display-helper.exe",
    },
    {
      from: "apps/bridge/native/meeting-helper/meeting-helper.exe",
      to: "native/meeting-helper/meeting-helper.exe",
    },
    {
      from: "apps/bridge/native/meeting-helper/onnxruntime.dll",
      to: "native/meeting-helper/onnxruntime.dll",
    },
    {
      // MODNet model ships on Windows only (macOS uses the Apple Vision keyer).
      from: "apps/bridge/native/meeting-helper/models",
      to: "native/meeting-helper/models",
      filter: ["**/*"],
    },
  ];

  config.win.extraResources.push({
    from: "apps/bridge/native/display-helper/SDL2.dll",
    to: "native/display-helper/SDL2.dll",
  });
}

if (config.win) {
  const productName =
    typeof config.productName === "string" && config.productName.trim() !== ""
      ? config.productName.trim()
      : "App";
  const windowsExecutableBaseName = productName.replace(/\s+/g, "");

  // Work around electron-builder 25.1.8 Azure Trusted Signing command construction,
  // which does not quote the Files parameter and breaks on paths containing spaces.
  if (!config.win.executableName) {
    config.win.executableName = windowsExecutableBaseName;
  }
}

const azureVars = [
  "AZURE_CODE_SIGNING_PUBLISHER_NAME",
  "AZURE_CODE_SIGNING_ENDPOINT",
  "AZURE_CODE_SIGNING_ACCOUNT_NAME",
  "AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME",
];

const hasCompleteAzureTrustedSigningConfig = azureVars.every((name) => {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "";
});

if (config.win) {
  if (!hasCompleteAzureTrustedSigningConfig) {
    delete config.win.azureSignOptions;
  } else if (config.win.azureSignOptions) {
    const { publisherName: _ignoredPublisherName, ...azureSignOptions } =
      config.win.azureSignOptions;

    // Inject resolved values directly because Azure Trusted Signing options are not
    // reliably macro-expanded when passed through a JS config object.
    config.win.publisherName = process.env.AZURE_CODE_SIGNING_PUBLISHER_NAME.trim();
    config.win.azureSignOptions = {
      ...azureSignOptions,
      endpoint: process.env.AZURE_CODE_SIGNING_ENDPOINT.trim(),
      codeSigningAccountName:
        process.env.AZURE_CODE_SIGNING_ACCOUNT_NAME.trim(),
      certificateProfileName:
        process.env.AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME.trim(),
    };
  }
}

module.exports = config;
