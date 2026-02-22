const baseConfig = require("./electron-builder.json");

const config = JSON.parse(JSON.stringify(baseConfig));

const MAC_ONLY_NATIVE_RESOURCES = new Set([
  "apps/bridge/native/decklink-helper/decklink-helper",
  "apps/bridge/native/display-helper/display-helper",
]);

// Keep macOS-only helper binaries out of Windows/Linux packaging to avoid missing-file warnings.
const macOnlyResources = (config.extraResources || []).filter((entry) =>
  MAC_ONLY_NATIVE_RESOURCES.has(entry.from),
);

config.extraResources = (config.extraResources || []).filter(
  (entry) => !MAC_ONLY_NATIVE_RESOURCES.has(entry.from),
);

config.mac = config.mac || {};
config.mac.extraResources = [
  ...(config.mac.extraResources || []),
  ...macOnlyResources,
];

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

if (!hasCompleteAzureTrustedSigningConfig && config.win) {
  delete config.win.azureSignOptions;
}

module.exports = config;
