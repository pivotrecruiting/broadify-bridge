#!/usr/bin/env node
/**
 * TLS-inspection replica for the Broadify relay connection.
 *
 * Plays the role of a corporate inspecting firewall: terminates TLS with the
 * private root CA from make-ca.sh and forwards the WebSocket traffic to the
 * real relay. Used to verify how the bridge behaves when the relay certificate
 * chain is re-signed. Documentation: docs/bridge/dev/tls-inspection-replica.md
 *
 * Usage:
 *   node scripts/tls-inspection-replica/proxy.mjs --relay-host <host>
 *        [--listen 0.0.0.0:8443] [--cert-dir <dir>] [--upstream-ip <ip>]
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { Resolver } from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LISTEN = "0.0.0.0:8443";
const UPSTREAM_PORT = 443;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const FALLBACK_CLOSE_CODE = 1011;

const log = (message) =>
  console.log(`[replica ${new Date().toISOString()}] ${message}`);

const usage = () => {
  console.error(
    "usage: proxy.mjs --relay-host <host> [--listen host:port] [--cert-dir dir] [--upstream-ip ip]"
  );
  process.exit(2);
};

const parseArgs = (argv) => {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      usage();
    }
    args[key.slice(2)] = value;
  }
  return args;
};

const parseListen = (listen) => {
  const separator = listen.lastIndexOf(":");
  const host = separator > 0 ? listen.slice(0, separator) : listen;
  const port = Number.parseInt(listen.slice(separator + 1), 10);
  if (separator <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid --listen value "${listen}", expected host:port`);
  }
  return { host, port };
};

/**
 * Resolve the relay host through the DNS servers directly. Unlike dns.lookup
 * this ignores the hosts file, so a hosts entry that points the relay host at
 * this machine (single-machine setup) cannot loop back into the proxy.
 */
const resolveUpstreamIp = async (relayHost, override) => {
  if (override) {
    if (net.isIP(override) === 0) {
      throw new Error(`--upstream-ip "${override}" is not an IP address`);
    }
    return override;
  }
  const addresses = await new Resolver().resolve4(relayHost);
  if (addresses.length === 0) {
    throw new Error(`DNS returned no IPv4 address for ${relayHost}`);
  }
  return addresses[0];
};

/** RFC 6455 forbids sending the reserved codes 1004-1006 and anything < 1000. */
const sanitizeCloseCode = (code) =>
  Number.isInteger(code) && code >= 1000 && code <= 4999 && (code < 1004 || code > 1006)
    ? code
    : FALLBACK_CLOSE_CODE;

const closeQuietly = (socket, code, reason) => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.close(sanitizeCloseCode(code), reason);
  } else if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
  }
};

const pipeSockets = (client, upstream, label) => {
  const pending = [];

  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    } else {
      pending.push([data, isBinary]);
    }
  });
  upstream.on("open", () => {
    log(`${label} upstream connected, ${pending.length} buffered message(s) flushed`);
    for (const [data, isBinary] of pending.splice(0)) {
      upstream.send(data, { binary: isBinary });
    }
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary });
    }
  });

  client.on("close", (code, reason) => {
    log(`${label} client closed (code ${code})`);
    closeQuietly(upstream, code, reason.toString("utf-8").slice(0, 120));
  });
  upstream.on("close", (code, reason) => {
    log(`${label} upstream closed (code ${code})`);
    closeQuietly(client, code, reason.toString("utf-8").slice(0, 120));
  });
  client.on("error", (error) => {
    log(`${label} client error: ${error.code ?? error.message}`);
    closeQuietly(upstream, FALLBACK_CLOSE_CODE, "client error");
  });
  upstream.on("error", (error) => {
    log(`${label} upstream error: ${error.code ?? error.message}`);
    closeQuietly(client, FALLBACK_CLOSE_CODE, "upstream error");
  });
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const relayHost = args["relay-host"];
  if (!relayHost) {
    usage();
  }
  const certDir = args["cert-dir"] ?? path.join(SCRIPT_DIR, "out");
  const { host, port } = parseListen(args.listen ?? DEFAULT_LISTEN);
  const upstreamIp = await resolveUpstreamIp(relayHost, args["upstream-ip"]);

  const server = createServer({
    key: readFileSync(path.join(certDir, "leaf.key")),
    cert: readFileSync(path.join(certDir, "chain.pem")),
  });
  server.on("tlsClientError", (error, socket) => {
    log(
      `client ${socket.remoteAddress ?? "?"} rejected our certificate during the TLS handshake: ${
        error.code ?? error.message
      }`
    );
  });

  let connectionCounter = 0;
  const wss = new WebSocketServer({ server });
  wss.on("connection", (client, request) => {
    connectionCounter += 1;
    const label = `#${connectionCounter} ${request.socket.remoteAddress ?? "?"}`;
    const requestedProtocols = request.headers["sec-websocket-protocol"];
    log(
      `${label} client connected on ${request.url}, forwarding to wss://${upstreamIp}:${UPSTREAM_PORT} (SNI/Host ${relayHost})`
    );
    const upstream = new WebSocket(
      `wss://${upstreamIp}:${UPSTREAM_PORT}${request.url}`,
      requestedProtocols ? requestedProtocols.split(",").map((value) => value.trim()) : [],
      {
        servername: relayHost,
        headers: { Host: relayHost },
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      }
    );
    pipeSockets(client, upstream, label);
  });

  server.listen(port, host, () => {
    log(`listening on ${host}:${port}, presenting the fake chain for ${relayHost}`);
    log(`upstream relay: ${relayHost} -> ${upstreamIp}:${UPSTREAM_PORT}`);
  });
};

main().catch((error) => {
  console.error(`[replica] fatal: ${error.message}`);
  process.exit(1);
});
