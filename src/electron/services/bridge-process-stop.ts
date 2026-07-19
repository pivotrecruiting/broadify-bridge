type BridgeChildProcessLikeT = {
  pid?: number;
  kill: (signal: NodeJS.Signals) => void;
  once: (event: "exit", listener: () => void) => void;
};

/**
 * Sends a signal to the child's whole process group (POSIX) so grandchildren
 * (graphics renderers, meeting helper, soffice) die with it; falls back to
 * the single PID when no group exists or on Windows.
 */
function signalProcessTree(
  processRef: BridgeChildProcessLikeT,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && typeof processRef.pid === "number") {
    try {
      process.kill(-processRef.pid, signal);
      return;
    } catch {
      // Group already gone or not a group leader; fall through.
    }
  }
  try {
    processRef.kill(signal);
  } catch {
    // Process already exited.
  }
}

/**
 * Stop a child process (and its process group) gracefully and force-kill on
 * timeout. Never rejects: on timeout the tree receives SIGKILL and shutdown
 * continues — a hanging bridge must not block quitting the app.
 */
export async function stopChildProcessGracefully(
  processRef: BridgeChildProcessLikeT,
  timeoutMs: number = 5000,
): Promise<void> {
  signalProcessTree(processRef, "SIGTERM");

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      signalProcessTree(processRef, "SIGKILL");
      resolve();
    }, timeoutMs);

    processRef.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
