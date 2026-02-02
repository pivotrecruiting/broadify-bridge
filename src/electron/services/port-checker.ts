import { createServer } from "net";

/**
 * Check if a port is available.
 *
 * @param port Port number to check.
 * @param host Host to bind to (default: 0.0.0.0).
 * @returns True if port is available, false if in use.
 */
export async function isPortAvailable(
  port: number,
  host: string = "0.0.0.0"
): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        server.removeAllListeners();
        try {
          server.close();
        } catch {
          // Ignore errors during cleanup
        }
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, 2000); // 2 second timeout

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (resolved) return;
      clearTimeout(timeout);

      if (err.code === "EADDRINUSE") {
        cleanup();
        resolve(false);
      } else {
        cleanup();
        resolve(false);
      }
    });

    server.once("listening", () => {
      if (resolved) return;
      clearTimeout(timeout);
      server.once("close", () => {
        cleanup();
        resolve(true);
      });
      server.close();
    });

    try {
      server.listen(port, host);
    } catch {
      if (resolved) return;
      clearTimeout(timeout);
      cleanup();
      resolve(false);
    }
  });
}

/**
 * Find the next available port starting from a given port.
 *
 * @param startPort Starting port number.
 * @param maxPort Maximum port to check (default: startPort + 100).
 * @param host Host to bind to (default: 0.0.0.0).
 * @returns Available port number or null if none found.
 */
export async function findAvailablePort(
  startPort: number,
  maxPort?: number,
  host: string = "0.0.0.0"
): Promise<number | null> {
  const max = maxPort || startPort + 100;

  for (let port = startPort; port <= max; port++) {
    const available = await isPortAvailable(port, host);
    if (available) {
      return port;
    }
  }

  return null;
}

/**
 * Check multiple ports in parallel.
 *
 * @param ports Array of port numbers to check.
 * @param host Host to bind to (default: 0.0.0.0).
 * @returns Map of port -> availability.
 */
export async function checkPortsAvailability(
  ports: number[],
  host: string = "0.0.0.0"
): Promise<Map<number, boolean>> {
  const results = new Map<number, boolean>();

  // Check ports in parallel (with limit to avoid too many concurrent connections)
  const batchSize = 10;
  for (let i = 0; i < ports.length; i += batchSize) {
    const batch = ports.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (port) => {
        const available = await isPortAvailable(port, host);
        return { port, available };
      })
    );

    batchResults.forEach(({ port, available }) => {
      results.set(port, available);
    });
  }

  return results;
}
