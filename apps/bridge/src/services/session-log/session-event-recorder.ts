import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  SESSION_EVENT_SCHEMA_VERSION,
  SessionEventSchema,
  SessionHeaderSchema,
  type SessionEventT,
  type SessionHeaderT,
  type SwitcherEventT,
} from "./session-log-types.js";

const FLUSH_DELAY_MS = 1000;
const MAX_SESSION_EVENTS = 200_000;

type SessionRecorderOptionsT = {
  /** Directory for session files; defaults to <userData>/session-log (resolved by the caller). */
  dir: string;
  bridgeId?: string | null;
  now?: () => number;
  flushDelayMs?: number;
  newSessionId?: () => string;
};

type OpenSessionT = {
  header: SessionHeaderT;
  file: string;
  count: number;
};

/**
 * Append-only JSONL recorder for the post-production SessionEventLog.
 *
 * One file per recording session (`<session_id>.jsonl`): a header line, then
 * events. A session opens on `recording_started` (or startSession) and closes
 * on `recording_stopped`. The recorder keeps the latest on-air state per
 * (source, me, keyer) so a new session starts with a snapshot of what is on
 * air. Observability only: entry points are synchronous and swallow their own
 * failures, so switcher handling can never be slowed down or broken.
 * Contract: session-log-types.ts / broadify-postpro contracts.
 */
export class SessionEventRecorder {
  private readonly dir: string;
  private readonly bridgeId: string | null;
  private readonly now: () => number;
  private readonly flushDelayMs: number;
  private readonly newSessionId: () => string;

  private session: OpenSessionT | null = null;
  private readonly onAirState = new Map<string, SessionEventT>();
  private pending: Array<{ file: string; line: string }> = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushChain: Promise<void> = Promise.resolve();

  constructor(options: SessionRecorderOptionsT) {
    this.dir = options.dir;
    this.bridgeId = options.bridgeId ?? null;
    this.now = options.now ?? Date.now;
    this.flushDelayMs = options.flushDelayMs ?? FLUSH_DELAY_MS;
    this.newSessionId = options.newSessionId ?? randomUUID;
  }

  get currentSessionId(): string | null {
    return this.session?.header.session_id ?? null;
  }

  /** Feed a switcher event. Opens/closes sessions on recording events. */
  record(input: SwitcherEventT): void {
    try {
      const parsed = SessionEventSchema.safeParse({ ...input, at_ms: input.at_ms ?? this.now(), origin: "live" });
      if (!parsed.success) {
        return;
      }
      const event = parsed.data;
      this.trackState(event);
      if (event.type === "recording_started" && !this.session) {
        this.startSession(event.source, event.at_ms);
        this.append(event);
        return;
      }
      if (!this.session) {
        return;
      }
      this.append(event);
      if (event.type === "recording_stopped") {
        this.endSession();
      }
    } catch {
      // never throw into the switcher hot path
    }
  }

  /** Explicit session start (e.g. meeting recorder without a switcher event). */
  startSession(switcher: string, at?: number): string {
    if (this.session) {
      return this.session.header.session_id;
    }
    const header: SessionHeaderT = SessionHeaderSchema.parse({
      schema_version: SESSION_EVENT_SCHEMA_VERSION,
      session_id: this.newSessionId(),
      bridge_id: this.bridgeId,
      started_at_ms: at ?? this.now(),
      switcher,
    });
    this.session = { header, file: path.join(this.dir, `${header.session_id}.jsonl`), count: 0 };
    this.pending.push({ file: this.session.file, line: `${JSON.stringify(header)}\n` });
    // Snapshot: everything currently on air, stamped at session start.
    for (const event of this.onAirState.values()) {
      this.append({ ...event, at_ms: header.started_at_ms });
    }
    this.scheduleFlush();
    return header.session_id;
  }

  endSession(): string | null {
    const id = this.currentSessionId;
    this.scheduleFlush();
    this.session = null;
    return id;
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushNow();
  }

  /** Read a finished or running session file (header + events). Torn lines are skipped. */
  async readSession(sessionId: string): Promise<{ header: SessionHeaderT; events: SessionEventT[] } | null> {
    await this.flushNow();
    let raw: string;
    try {
      raw = await fs.readFile(path.join(this.dir, `${sessionId}.jsonl`), "utf8");
    } catch {
      return null;
    }
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const header = SessionHeaderSchema.safeParse(JSON.parse(lines[0] ?? "null"));
    if (!header.success) {
      return null;
    }
    const events: SessionEventT[] = [];
    for (const line of lines.slice(1)) {
      try {
        const parsed = SessionEventSchema.safeParse(JSON.parse(line));
        if (parsed.success) {
          events.push(parsed.data);
        }
      } catch {
        // torn line
      }
    }
    return { header: header.data, events };
  }

  private trackState(event: SessionEventT): void {
    const key = `${event.source}|${event.me ?? ""}|${event.keyer ?? ""}`;
    switch (event.type) {
      case "program_changed":
        this.onAirState.set(`${key}|program`, event);
        break;
      case "keyer_on_air":
      case "overlay_on_air":
        this.onAirState.set(`${key}|on`, event);
        break;
      case "keyer_off_air":
      case "overlay_off_air":
        this.onAirState.delete(`${key}|on`);
        break;
      case "graphic_shown":
        this.onAirState.set(`${event.source}|graphic|${event.graphic_id ?? ""}`, event);
        break;
      case "graphic_hidden":
        this.onAirState.delete(`${event.source}|graphic|${event.graphic_id ?? ""}`);
        break;
      default:
        break;
    }
  }

  private append(event: SessionEventT): void {
    if (!this.session || this.session.count >= MAX_SESSION_EVENTS) {
      return;
    }
    this.session.count += 1;
    this.pending.push({ file: this.session.file, line: `${JSON.stringify(event)}\n` });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, this.flushDelayMs);
    this.flushTimer.unref?.();
  }

  private flushNow(): Promise<void> {
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) {
      return this.flushChain;
    }
    const byFile = new Map<string, string[]>();
    for (const { file, line } of batch) {
      byFile.set(file, [...(byFile.get(file) ?? []), line]);
    }
    this.flushChain = this.flushChain
      .then(async () => {
        await fs.mkdir(this.dir, { recursive: true });
        for (const [file, lines] of byFile) {
          await fs.appendFile(file, lines.join(""), "utf8");
        }
      })
      .catch(() => {
        // best-effort log
      });
    return this.flushChain;
  }
}
