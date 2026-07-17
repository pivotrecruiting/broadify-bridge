const PATCH_MARKER = Symbol.for(
  "broadify.windowsAzureSigningSerializationInstalled",
);

function serializeWindowsAzureSigning(WinPackager) {
  const prototype = WinPackager?.prototype;
  if (!prototype || prototype[PATCH_MARKER]) {
    return false;
  }

  const originalSign = prototype.sign;
  if (typeof originalSign !== "function") {
    throw new TypeError("WinPackager.prototype.sign must be a function");
  }

  const signingQueues = new WeakMap();

  prototype.sign = function serializedWindowsSign(file) {
    if (!this.platformSpecificBuildOptions?.azureSignOptions) {
      return originalSign.call(this, file);
    }

    const previous = signingQueues.get(this) ?? Promise.resolve();
    const pending = previous.then(() => originalSign.call(this, file));
    signingQueues.set(this, pending);

    void pending
      .finally(() => {
        if (signingQueues.get(this) === pending) {
          signingQueues.delete(this);
        }
      })
      .catch(() => undefined);

    return pending;
  };

  Object.defineProperty(prototype, PATCH_MARKER, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });

  return true;
}

module.exports = { serializeWindowsAzureSigning };
