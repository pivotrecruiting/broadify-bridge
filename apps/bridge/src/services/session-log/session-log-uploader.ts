import { promises as fs } from "node:fs";
import path from "node:path";
import type { BridgeSigningIdentityT } from "../postpro/bridge-assertion.js";
import { signedPlatformPost, type PlatformFetchT } from "../postpro/platform-client.js";
import { SessionHeaderSchema } from "./session-log-types.js";

const MARKER_SUFFIX = ".uploaded.json";
const MAX_ATTEMPTS = 5;
const RESCAN_INTERVAL_MS = 10 * 60 * 1000;

export type SessionLogUploaderOptionsT = {
  /** Web-app base URL, e.g. https://<preview>.vercel.app */
  apiBaseUrl: string;
  dir: string;
  getIdentity: () => Promise<BridgeSigningIdentityT>;
  fetchFn?: PlatformFetchT;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
  /** Session currently being written; never uploaded by a scan. */
  isSessionOpen?: (sessionId: string) => boolean;
  /** Runs before each periodic rescan (retention); failures are ignored. */
  beforePeriodicScan?: () => Promise<unknown>;
};

/**
 * Uploads finished SessionEventLog files to the post-production platform:
 * upload-url (bridge-signed) → PUT the file to the signed URL → complete
 * (bridge-signed). A marker file next to the log records success so a
 * restart never re-uploads; failures are retried on the next session end or
 * startup scan (bounded attempts, never throws into the caller).
 */
export class SessionLogUploader {
  private readonly fetchFn: PlatformFetchT;
  private readonly attempts = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private rescanTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: SessionLogUploaderOptionsT) {
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  /** Queue one session (serialised; errors are logged, not thrown). */
  enqueue(sessionId: string): Promise<void> {
    this.chain = this.chain.then(() => this.uploadSession(sessionId)).catch((error) => {
      this.options.logger?.warn(`[SessionLog] upload of ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.chain;
  }

  /** Periodic retry of leftovers (attempt counters reset so a long-running bridge recovers). */
  startPeriodicScan(intervalMs = RESCAN_INTERVAL_MS): void {
    this.stopPeriodicScan();
    this.rescanTimer = setInterval(() => {
      this.attempts.clear();
      void Promise.resolve()
        .then(() => this.options.beforePeriodicScan?.())
        .catch(() => undefined)
        .then(() => this.scan());
    }, intervalMs);
    this.rescanTimer.unref?.();
  }

  stopPeriodicScan(): void {
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }
  }

  /** Upload every finished session file without a marker (startup / retry). Open sessions are skipped. */
  async scan(): Promise<void> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.options.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) {
        continue;
      }
      const sessionId = name.slice(0, -".jsonl".length);
      if (names.includes(`${sessionId}${MARKER_SUFFIX}`) || this.options.isSessionOpen?.(sessionId)) {
        continue;
      }
      await this.enqueue(sessionId);
    }
  }

  private async uploadSession(sessionId: string): Promise<void> {
    const file = path.join(this.options.dir, `${sessionId}.jsonl`);
    const marker = path.join(this.options.dir, `${sessionId}${MARKER_SUFFIX}`);
    try {
      await fs.access(marker);
      return;
    } catch {
      // not uploaded yet
    }
    const attempts = (this.attempts.get(sessionId) ?? 0) + 1;
    if (attempts > MAX_ATTEMPTS) {
      return;
    }
    this.attempts.set(sessionId, attempts);

    const raw = await fs.readFile(file, "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    const header = SessionHeaderSchema.parse(JSON.parse(lines[0] ?? "{}"));
    let endedAtMs: number | null = null;
    let eventCount = 0;
    for (const line of lines.slice(1)) {
      try {
        const event = JSON.parse(line) as { at_ms?: number; type?: string };
        eventCount += 1;
        if (event.type === "recording_stopped" && typeof event.at_ms === "number") {
          endedAtMs = event.at_ms;
        }
      } catch {
        // torn line
      }
    }

    const target = await this.signedPost<{ path: string; token: string; url: string }>("/api/postpro/bridge/sessions/upload-url", { session_id: sessionId });
    const put = await this.fetchFn(target.url, { method: "PUT", headers: { "content-type": "application/x-ndjson", "x-upsert": "true" }, body: raw });
    if (!put.ok) {
      throw new Error(`PUT ${put.status}: ${(await put.text()).slice(0, 200)}`);
    }
    await this.signedPost<{ id: string }>("/api/postpro/bridge/sessions/complete", {
      session_id: sessionId,
      switcher: header.switcher,
      started_at_ms: header.started_at_ms,
      ended_at_ms: endedAtMs,
      event_count: eventCount,
      storage_path: target.path,
    });
    await fs.writeFile(marker, JSON.stringify({ uploaded_at_ms: Date.now(), storage_path: target.path, event_count: eventCount }), "utf8");
    this.attempts.delete(sessionId);
    this.options.logger?.info(`[SessionLog] uploaded ${sessionId} (${eventCount} events)`);
  }

  private signedPost<T>(route: string, payload: Record<string, unknown>): Promise<T> {
    return signedPlatformPost<T>({ baseUrl: this.options.apiBaseUrl, route, payload, getIdentity: this.options.getIdentity, fetchFn: this.fetchFn });
  }
}
