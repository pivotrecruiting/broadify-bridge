# Bridge Dokumentation

## Übersicht

Die Bridge (`apps/bridge/`) ist ein separater Node.js-HTTP-Server, der als Child Process von der Desktop App gestartet wird. Sie stellt einen Status-Endpoint bereit und wird zukünftig Device-Module, Cloud-Tunnel und LAN-Server-Funktionalität bereitstellen.

## Architektur

```
Bridge Process
    │
    ├── CLI Arguments (--host, --port)
    │
    ├── Config Parsing (Zod Validation)
    │
    ├── Fastify Server
    │   │
    │   └── Routes
    │       └── /status (GET)
    │
    └── Graceful Shutdown (SIGTERM/SIGINT)
```

## Entry Point: `src/index.ts`

```typescript
async function main() {
  const args = process.argv.slice(2);
  const config = parseConfig(args); // Zod validation
  const server = await createServer(config);
  await startServer(server, config);
}
```

**CLI Arguments:**

- `--host <ip>` - IP-Adresse zum Binden (z.B. `127.0.0.1`, `0.0.0.0`)
- `--port <number>` - Port-Nummer (z.B. `8787`)

**Beispiel:**

```bash
node dist/index.js --host 127.0.0.1 --port 8787
```

## Config: `src/config.ts`

### Zod Schema

```typescript
const ConfigSchema = z.object({
  host: z.string().ip({ version: "v4" }),
  port: z.number().int().min(1).max(65535),
  mode: z.enum(["lan", "local"]),
});
```

### Mode-Derivation

Der `mode` wird automatisch aus `host` abgeleitet:

- `host === "0.0.0.0"` → `mode: "lan"`
- `host === "127.0.0.1"` → `mode: "local"`
- Andere IPs → `mode: "lan"`

### Parse Function

```typescript
export function parseConfig(args: string[]): BridgeConfigT {
  // Parse CLI arguments
  // Derive mode from host
  // Validate with Zod
  return ConfigSchema.parse(config);
}
```

## Server: `src/server.ts`

### Server Creation

```typescript
export async function createServer(config: BridgeConfigT) {
  const server = Fastify({
    logger: {
      level: process.env.NODE_ENV === "production" ? "info" : "debug",
      transport: /* pino-pretty in dev */
    },
  });

  await server.register(registerStatusRoute, { config });
  return server;
}
```

### Server Start

```typescript
export async function startServer(server, config) {
  await server.listen({ host: config.host, port: config.port });
  // Graceful shutdown handlers
}
```

**Fehlerbehandlung:**

- `EADDRINUSE` → Port bereits belegt
- `EADDRNOTAVAIL` → IP nicht verfügbar (Fallback zu `0.0.0.0`)

### Graceful Shutdown

```typescript
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

**Shutdown-Prozess:**

1. Loggt Shutdown-Signal
2. Schließt Server (`server.close()`)
3. Exit mit Code 0

## Routes: `src/routes/status.ts`

### GET /status

**Response:**

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 12345,
  "mode": "local",
  "host": "127.0.0.1",
  "port": 8787
}
```

**Felder:**

- `status` - Immer `"ok"` wenn Endpoint erreichbar
- `version` - Bridge-Version (aus package.json)
- `uptime` - Sekunden seit Start
- `mode` - `"lan"` oder `"local"`
- `host` - Gebundene IP-Adresse
- `port` - Gebundener Port

**Verwendung:**

- Health Check von Desktop App
- Status-Anzeige in UI

## Logging

### pino Logger

**Development:**

- Level: `debug`
- Transport: `pino-pretty` (formatiert)
- Zeigt Timestamps, Log-Level, Messages

**Production:**

- Level: `info`
- Kein Transport (JSON-Output)
- Strukturiert für Log-Aggregation

**Beispiel:**

```javascript
server.log.info(
  `Bridge server listening on http://${config.host}:${config.port}`
);
```

## Build & Deployment

### Development

```bash
cd apps/bridge
npm run dev
# Oder: npm run dev:lan (für LAN-Mode)
```

**Verwendet:**

- `tsx` - TypeScript Execution
- Watch-Mode für Hot Reload

### Production Build

```bash
cd apps/bridge
npm run build
# Kompiliert TypeScript → dist/
```

**Output:**

- `dist/index.js` - Entry Point
- `dist/config.js` - Config Module
- `dist/server.js` - Server Module
- `dist/routes/status.js` - Status Route

### Start Production

```bash
node dist/index.js --host 127.0.0.1 --port 8787
```

## Prozess-Management

### Start durch Desktop App

Die Desktop App startet die Bridge als Child Process:

```typescript
spawn("npx", [
  "tsx",
  "apps/bridge/src/index.ts",
  "--host",
  host,
  "--port",
  port,
]);
```

**Development:**

- `npx tsx src/index.ts --host ... --port ...`

**Production:**

- `node dist/index.js --host ... --port ...`

### Stop durch Desktop App

Die Desktop App sendet `SIGTERM` für graceful shutdown:

```typescript
bridgeProcess.kill("SIGTERM");
```

## Zukünftige Erweiterungen

### Geplante Features

1. **Device Modules**

   - ATEM-Adapter
   - Weitere Hardware-Unterstützung

2. **Cloud-Tunnel**

   - Verbindung zu Cloud-Service
   - Remote-Zugriff

3. **LAN-Server**

   - Erweiterte LAN-Funktionalität
   - Multi-Client-Support

4. **WebSocket Support**
   - Real-time Kommunikation
   - Event-Broadcasting

## Dependencies

### Runtime

- `fastify` - HTTP Server Framework
- `pino` - Logging
- `zod` - Config Validation

### Dev

- `tsx` - TypeScript Execution
- `@types/node` - Node.js Types

## Weitere Dokumentation

- [Architecture](./ARCHITECTURE.md) - Gesamtarchitektur
- [Main Process](./MAIN_PROCESS.md) - Bridge-Prozess-Management
- [IPC Communication](./IPC_COMMUNICATION.md) - Kommunikation mit Desktop App
