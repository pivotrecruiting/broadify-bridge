function resolveWindowsInstallDirectoryName(config) {
  const directoryName = config?.win?.executableName ?? config?.productName;
  if (
    typeof directoryName !== "string" ||
    directoryName.trim() === "" ||
    directoryName === "." ||
    directoryName === ".." ||
    /[\\/]/.test(directoryName)
  ) {
    throw new Error("Unable to resolve a safe Windows installation directory name.");
  }

  return directoryName.trim();
}

if (require.main === module) {
  const config = require("../electron-builder.config.cjs");
  process.stdout.write(resolveWindowsInstallDirectoryName(config));
}

module.exports = { resolveWindowsInstallDirectoryName };
