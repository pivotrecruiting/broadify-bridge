type BridgeChildProcessLikeT = {
  kill: (signal: NodeJS.Signals) => void;
  once: (event: "exit", listener: () => void) => void;
};

/**
 * Stop a child process gracefully and force-kill on timeout.
 */
export async function stopChildProcessGracefully(
  processRef: BridgeChildProcessLikeT,
  timeoutMs: number = 5000,
): Promise<void> {
  processRef.kill("SIGTERM");

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      processRef.kill("SIGKILL");
      reject(new Error("Bridge process did not exit in time"));
    }, timeoutMs);

    processRef.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
