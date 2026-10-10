import { promises as fs } from "node:fs";
import path from "node:path";
import { POSTPRO_BRIDGE_ASSERTION_HEADER, buildBridgeAssertion, type BridgeSigningIdentityT } from "./bridge-assertion.js";
import { SessionHeaderSchema } from "./session-log-types.js";

const MARKER_SUFFIX = ".uploaded.json";
const MAX_ATTEMPTS = 5;

type FetchLikeT = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Buffer }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export type SessionLogUploaderOptionsT = {
  /** Web-app base URL, e.g. https://<preview>.vercel.app */
  apiBaseUrl: string;
  dir: string;
  getIdentity: () => Promise<BridgeSigningIdentityT>;
  fetchFn?: FetchLikeT;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
};

/**
 * Uploads finished SessionEventLog files to the post-production platform:
 * upload-url (bridge-signed) → PUT the file to the signed URL → complete
 * (bridge-signed). A marker file next to the log records success so a
 * restart never re-uploads; failures are retried on the next session end or
 * startup scan (bounded attempts, never throws into the caller).
 */
export class SessionLogUploader {
  private readonly fetchFn: FetchLikeT;
  private readonly attempts = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();

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

  /** Upload every finished session file without a marker (startup / retry). */
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
      if (names.includes(`${sessionId}${MARKER_SUFFIX}`)) {
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

  private async signedPost<T>(route: string, payload: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify(payload);
    const identity = await this.options.getIdentity();
    const response = await this.fetchFn(`${this.options.apiBaseUrl.replace(/\/$/, "")}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", [POSTPRO_BRIDGE_ASSERTION_HEADER]: buildBridgeAssertion(body, identity) },
      body,
    });
    const text = await response.text();
    let parsed: { success?: boolean; data?: T; error?: string } | null = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!response.ok || !parsed?.success) {
      throw new Error(`${route}: HTTP ${response.status}: ${parsed?.error ?? text.slice(0, 200)}`);
    }
    return parsed.data as T;
  }
}
