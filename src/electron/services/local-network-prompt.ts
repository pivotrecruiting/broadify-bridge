import { createSocket } from "dgram";
import { logAppInfo, logAppWarn } from "./app-logger.js";

const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;

/**
 * DNS-SD service enumeration name; the standard, side-effect-free mDNS query
 * every Bonjour browser sends.
 */
const MDNS_SERVICE_ENUMERATION_NAME = "_services._dns-sd._udp.local";

/**
 * Encode a dotted DNS name into DNS wire format (length-prefixed labels,
 * terminated by the root label).
 */
function encodeDnsName(name: string): Buffer {
  const labels = name.split(".").map((label) => {
    const bytes = Buffer.from(label, "ascii");
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  return Buffer.concat([...labels, Buffer.from([0x00])]);
}

function buildServiceEnumerationQuery(): Buffer {
  const header = Buffer.from([
    0x00, 0x00, // transaction id (0 for mDNS)
    0x00, 0x00, // flags: standard query
    0x00, 0x01, // question count: 1
    0x00, 0x00, // answer count
    0x00, 0x00, // authority count
    0x00, 0x00, // additional count
  ]);
  const question = Buffer.concat([
    encodeDnsName(MDNS_SERVICE_ENUMERATION_NAME),
    Buffer.from([0x00, 0x0c]), // type PTR
    Buffer.from([0x00, 0x01]), // class IN
  ]);
  return Buffer.concat([header, question]);
}

/**
 * Nudge macOS into raising its "Local Network" permission prompt.
 *
 * macOS only shows the consent dialog when local-network traffic originates
 * from the app process itself. The bridge server runs as a helper child, and
 * traffic from helpers is often denied silently without any prompt — device
 * connections (ATEM/vMix/Canon) then fail with timeouts and the app never
 * appears under System Settings → Privacy → Local Network. Sending one
 * throwaway mDNS query from the main process at startup makes the prompt
 * appear; once granted, the permission covers the app and its child
 * processes.
 *
 * Best-effort and macOS-only: any failure is logged and ignored.
 */
export function triggerLocalNetworkPermissionPrompt(): void {
  if (process.platform !== "darwin") {
    return;
  }

  try {
    const socket = createSocket("udp4");

    socket.once("error", (error) => {
      logAppWarn(
        `[LocalNetwork] Permission nudge socket error: ${error.message}`,
      );
      try {
        socket.close();
      } catch {
        // Socket already closed.
      }
    });

    socket.send(
      buildServiceEnumerationQuery(),
      MDNS_PORT,
      MDNS_ADDRESS,
      (error) => {
        if (error) {
          logAppWarn(
            `[LocalNetwork] Permission nudge send failed: ${error.message}`,
          );
        } else {
          logAppInfo(
            "[LocalNetwork] Sent mDNS nudge to trigger the macOS local-network permission prompt",
          );
        }
        try {
          socket.close();
        } catch {
          // Socket already closed.
        }
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logAppWarn(`[LocalNetwork] Permission nudge failed: ${message}`);
  }
}
