const Module = require("node:module");
const {
  serializeWindowsAzureSigning,
} = require("./lib/serialize-windows-azure-signing.cjs");

const winPackagerModulePath =
  require.resolve("app-builder-lib/out/winPackager");

function installSerialization(moduleExports) {
  if (serializeWindowsAzureSigning(moduleExports?.WinPackager)) {
    console.log("[Signing] Azure Trusted Signing calls will run sequentially.");
  }
}

const cachedModule = require.cache[winPackagerModulePath];
if (cachedModule?.exports) {
  installSerialization(cachedModule.exports);
} else {
  const originalLoad = Module._load;

  Module._load = function loadWithWindowsSigningPatch(request, parent, isMain) {
    const loadedModule = originalLoad.call(this, request, parent, isMain);
    const loadedPath = Module._resolveFilename(request, parent, isMain);

    if (loadedPath === winPackagerModulePath) {
      Module._load = originalLoad;
      installSerialization(loadedModule);
    }

    return loadedModule;
  };
}
