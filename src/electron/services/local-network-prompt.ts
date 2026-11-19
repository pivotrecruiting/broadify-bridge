import { createSocket, type Socket } from "dgram";
import { networkInterfaces } from "os";
import { logAppInfo, logAppWarn } from "./app-logger.js";

const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;

/**
 * How many nudge rounds to attempt before giving up. This exists for the
 * boot-time race: the app auto-launches at login and fires the nudge within
 * seconds, but the primary NIC — often a USB-Ethernet adapter — may not have
 * enumerated yet, so the first round reaches no interface.
 */
const MAX_NUDGE_ATTEMPTS = 5;
const NUDGE_RETRY_DELAY_MS = 3000;

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
 * IPv4 addresses of every active, non-internal interface on this machine.
 */
function activeIpv4Addresses(): string[] {
  const addresses: string[] = [];
  const interfaces = networkInterfaces();
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      // Node reports family as "IPv4" (string) on current releases; guard the
      // numeric form too so a runtime change can't silently drop every address.
      const isIpv4 =
        info.family === "IPv4" || (info.family as unknown as number) === 4;
      if (isIpv4 && !info.internal && info.address) {
        addresses.push(info.address);
      }
    }
  }
  return addresses;
}

/**
 * Send one mDNS nudge out a specific local interface, pinning the multicast
 * egress to it. Resolves true on a successful send, false otherwise. Never
 * rejects — every failure is logged and swallowed.
 */
function sendNudgeFromInterface(localAddress: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, socket?: Socket): void => {
      if (socket) {
        try {
          socket.close();
        } catch {
          // Socket already closed.
        }
      }
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };

    let socket: Socket;
    try {
      socket = createSocket("udp4");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logAppWarn(
        `[LocalNetwork] Nudge socket create failed on ${localAddress}: ${message}`,
      );
      resolve(false);
      return;
    }

    socket.once("error", (error) => {
      logAppWarn(
        `[LocalNetwork] Nudge socket error on ${localAddress}: ${error.message}`,
      );
      finish(false, socket);
    });

    // Bind to the interface and pin the multicast egress to it. Without this the
    // OS uses its default multicast route, which on multi-NIC Macs can point at
    // a down/virtual adapter → the send fails with EHOSTUNREACH and the macOS
    // Local Network prompt never appears.
    try {
      socket.bind({ address: localAddress }, () => {
        try {
          socket.setMulticastInterface(localAddress);
        } catch {
          // Not every interface accepts this; the bind alone still helps.
        }
        socket.send(
          buildServiceEnumerationQuery(),
          MDNS_PORT,
          MDNS_ADDRESS,
          (error) => {
            if (error) {
              logAppWarn(
                `[LocalNetwork] Nudge send failed on ${localAddress}: ${error.message}`,
              );
              finish(false, socket);
            } else {
              logAppInfo(`[LocalNetwork] Sent mDNS nudge via ${localAddress}`);
              finish(true, socket);
            }
          },
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logAppWarn(
        `[LocalNetwork] Nudge bind failed on ${localAddress}: ${message}`,
      );
      finish(false, socket);
    }
  });
}

/**
 * Run one nudge round across every active interface. Resolves true if at least
 * one interface accepted the send. Exported for tests.
 */
export async function sendLocalNetworkNudge(): Promise<boolean> {
  const addresses = activeIpv4Addresses();
  if (addresses.length === 0) {
    return false;
  }
  const results = await Promise.all(addresses.map(sendNudgeFromInterface));
  return results.some(Boolean);
}

/**
 * Nudge macOS into raising its "Local Network" permission prompt.
 *
 * macOS only shows the consent dialog when local-network traffic originates
 * from the app process itself, and only until a decision has been recorded.
 * Sending a throwaway mDNS query from the main process at startup makes the
 * prompt appear; once granted, the permission covers the app and its child
 * processes (bridge, helpers) so device connections (ATEM/vMix/Canon) work.
 *
 * The nudge is sent out every active interface (multi-NIC Macs) and retried a
 * few times with backoff (the primary NIC may not be up yet right after boot).
 *
 * Best-effort and macOS-only: any failure is logged and ignored.
 */
export function triggerLocalNetworkPermissionPrompt(): void {
  if (process.platform !== "darwin") {
    return;
  }
  void runNudgeWithRetries(1);
}

async function runNudgeWithRetries(attempt: number): Promise<void> {
  let ok = false;
  try {
    ok = await sendLocalNetworkNudge();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logAppWarn(`[LocalNetwork] Nudge attempt ${attempt} failed: ${message}`);
  }

  if (ok) {
    return;
  }

  if (attempt < MAX_NUDGE_ATTEMPTS) {
    logAppWarn(
      `[LocalNetwork] Nudge reached no interface (attempt ${attempt}/${MAX_NUDGE_ATTEMPTS}); retrying in ${NUDGE_RETRY_DELAY_MS}ms`,
    );
    const timer = setTimeout(() => {
      void runNudgeWithRetries(attempt + 1);
    }, NUDGE_RETRY_DELAY_MS);
    // Don't keep the process alive just for a retry.
    timer.unref?.();
  } else {
    logAppWarn(
      `[LocalNetwork] Nudge did not reach any interface after ${MAX_NUDGE_ATTEMPTS} attempts; the macOS Local Network prompt may not appear`,
    );
  }
}
