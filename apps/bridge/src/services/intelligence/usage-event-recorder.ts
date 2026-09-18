import { promises as fs } from "node:fs";
import path from "node:path";
import { getBridgeContext, type LoggerLikeT } from "../bridge-context.js";
import {
  USAGE_EVENT_VERSION,
  UsageEventSchema,
  type CallEndReasonT,
  type UsageEventT,
} from "./intelligence-types.js";

const USAGE_DIR_SEGMENTS = ["intelligence", "usage"] as const;
/**
 * Product scope (decision 2026-09-18): Conversation Intelligence covers the
 * MEETING mode only. The GraphicsManager hooks stay mode-agnostic; this
 * prefix gate is the single place that drops studio-plane events, so
 * widening the scope later is a one-line change (plus contract §1).
 */
const TRACKED_SOURCE_PREFIX = "meeting-";
const CURRENT_FILE_NAME = "usage-current.jsonl";
const ROTATED_FILE_PREFIX = "usage-";
const ROTATED_FILE_SUFFIX = ".jsonl";
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED_FILES = 5;
const FLUSH_DELAY_MS = 1000;
/** Events buffered in memory before initialize(); overflow drops oldest. */
const MAX_PENDING_LINES = 2000;

export type UsageRecorderLayerShownT = {
  source: string;
  layerId: string;
  category: string;
  presetId?: string;
  reportPresetId?: string;
};

export type UsageRecorderLayerHiddenT = {
  source: string;
  layerId: string;
  reason: string;
};

/**
 * The narrow surface GraphicsManager and the meeting manager depend on, so
 * tests inject a fake instead of touching the filesystem singleton.
 */
export type GraphicsUsageRecorderLikeT = {
  recordLayerShown: (input: UsageRecorderLayerShownT) => void;
  recordLayerHidden: (input: UsageRecorderLayerHiddenT) => void;
  recordCallStarted: (callId: string, at?: number) => void;
  recordCallEnded: (callId: string, reason: CallEndReasonT, at?: number) => void;
};

type OpenLayerT = {
  category: string;
  presetId?: string;
  reportPresetId?: string;
};

type UsageRecorderOptionsT = {
  maxFileBytes?: number;
  maxRotatedFiles?: number;
  flushDelayMs?: number;
  now?: () => number;
};

function openLayerKey(source: string, layerId: string): string {
  return `${source}\u0000${layerId}`;
}

function sameLayerIdentity(
  open: OpenLayerT,
  next: UsageRecorderLayerShownT,
): boolean {
  return (
    open.category === next.category &&
    (open.presetId ?? null) === (next.presetId ?? null) &&
    (open.reportPresetId ?? null) === (next.reportPresetId ?? null)
  );
}

/**
 * Append-only JSONL recorder for graphics on-air intervals and call markers.
 *
 * Observability only: every entry point is synchronous and swallows its own
 * failures, so the graphics hot path and the meeting status poll can never be
 * slowed down or broken by usage tracking. Writes are debounced and appended
 * off the caller's stack; rotation mirrors services/log-file.ts (5 MB current
 * file, 5 rotated siblings). Contract: intelligence-types.ts +
 * docs/integration/conversation-intelligence-contract.md.
 */
export class GraphicsUsageRecorder implements GraphicsUsageRecorderLikeT {
  private readonly maxFileBytes: number;
  private readonly maxRotatedFiles: number;
  private readonly flushDelayMs: number;
  private readonly now: () => number;

  private readonly openLayers = new Map<string, OpenLayerT>();
  private pendingLines: string[] = [];
  private droppedBeforeInit = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private usageDir: string | null = null;
  private approxCurrentBytes = 0;
  private writeFailureLogged = false;

  constructor(options: UsageRecorderOptionsT = {}) {
    this.maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
    this.maxRotatedFiles = options.maxRotatedFiles ?? MAX_ROTATED_FILES;
    this.flushDelayMs = options.flushDelayMs ?? FLUSH_DELAY_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Resolve the log location from the bridge context and take over the size
   * of an existing current file. Safe to call once at server startup; events
   * recorded earlier are buffered (bounded) and flushed from here on.
   */
  async initialize(): Promise<void> {
    const context = getBridgeContext();
    this.usageDir = path.join(context.userDataDir, ...USAGE_DIR_SEGMENTS);
    await fs.mkdir(this.usageDir, { recursive: true });
    try {
      const stat = await fs.stat(this.currentFilePath());
      this.approxCurrentBytes = stat.size;
    } catch {
      this.approxCurrentBytes = 0;
    }
    if (this.droppedBeforeInit > 0) {
      context.logger.warn(
        `[Intelligence] Usage recorder dropped ${this.droppedBeforeInit} event(s) buffered before initialization`,
      );
      this.droppedBeforeInit = 0;
    }
    if (this.pendingLines.length > 0) {
      this.scheduleFlush();
    }
  }

  recordLayerShown(input: UsageRecorderLayerShownT): void {
    if (!input.source.startsWith(TRACKED_SOURCE_PREFIX)) {
      return;
    }
    const key = openLayerKey(input.source, input.layerId);
    const open = this.openLayers.get(key);
    if (open && sameLayerIdentity(open, input)) {
      // Continuation: repeated sends of the same graphic (builder syncs,
      // value updates) keep one on-air interval instead of inflating counts.
      return;
    }
    const at = this.now();
    if (open) {
      this.enqueue({
        v: USAGE_EVENT_VERSION,
        type: "graphic_hidden",
        at,
        source: input.source,
        layer_id: input.layerId,
        reason: "replaced",
      });
    }
    this.openLayers.set(key, {
      category: input.category,
      presetId: input.presetId,
      reportPresetId: input.reportPresetId,
    });
    this.enqueue({
      v: USAGE_EVENT_VERSION,
      type: "graphic_shown",
      at,
      source: input.source,
      layer_id: input.layerId,
      category: input.category,
      ...(input.presetId ? { preset_id: input.presetId } : {}),
      ...(input.reportPresetId
        ? { report_preset_id: input.reportPresetId }
        : {}),
    });
  }

  recordLayerHidden(input: UsageRecorderLayerHiddenT): void {
    if (!input.source.startsWith(TRACKED_SOURCE_PREFIX)) {
      return;
    }
    const key = openLayerKey(input.source, input.layerId);
    if (!this.openLayers.delete(key)) {
      // Never opened (failed render, duplicate remove): nothing to close.
      return;
    }
    this.enqueue({
      v: USAGE_EVENT_VERSION,
      type: "graphic_hidden",
      at: this.now(),
      source: input.source,
      layer_id: input.layerId,
      reason: input.reason,
    });
  }

  recordCallStarted(callId: string, at?: number): void {
    this.enqueue({
      v: USAGE_EVENT_VERSION,
      type: "call_started",
      at: at ?? this.now(),
      call_id: callId,
    });
  }

  recordCallEnded(callId: string, reason: CallEndReasonT, at?: number): void {
    this.enqueue({
      v: USAGE_EVENT_VERSION,
      type: "call_ended",
      at: at ?? this.now(),
      call_id: callId,
      reason,
    });
  }

  /** Close every open interval (used at bridge shutdown). Idempotent. */
  closeAllOpenLayers(reason: string): void {
    for (const key of Array.from(this.openLayers.keys())) {
      const [source, layerId] = key.split("\u0000");
      this.recordLayerHidden({ source, layerId, reason });
    }
  }

  /** Close remaining intervals and flush pending lines to disk. */
  async shutdown(): Promise<void> {
    this.closeAllOpenLayers("shutdown");
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushNow();
  }

  /** Force pending lines to disk (upload slicing reads the files). */
  async flush(): Promise<void> {
    await this.flushNow();
  }

  /**
   * Read all persisted events with `at` inside [fromMs, toMs], oldest file
   * first. Invalid lines are skipped (never thrown): the log is best-effort
   * and a torn last line after a crash must not block an upload.
   */
  async readEventsInRange(fromMs: number, toMs: number): Promise<UsageEventT[]> {
    if (!this.usageDir) {
      return [];
    }
    await this.flushNow();
    const events: UsageEventT[] = [];
    let names: string[];
    try {
      names = (await fs.readdir(this.usageDir))
        .filter(
          (name) =>
            name.startsWith(ROTATED_FILE_PREFIX) &&
            name.endsWith(ROTATED_FILE_SUFFIX),
        )
        .sort();
    } catch {
      return [];
    }
    // usage-current.jsonl sorts before the rotated stamps alphabetically but
    // is chronologically last — move it to the end explicitly.
    names = names
      .filter((name) => name !== CURRENT_FILE_NAME)
      .concat(names.includes(CURRENT_FILE_NAME) ? [CURRENT_FILE_NAME] : []);
    for (const name of names) {
      let raw: string;
      try {
        raw = await fs.readFile(
          path.join(this.usageDir, name),
          "utf8",
        );
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (line.length === 0) {
          continue;
        }
        try {
          const parsed = UsageEventSchema.safeParse(JSON.parse(line));
          if (
            parsed.success &&
            parsed.data.at >= fromMs &&
            parsed.data.at <= toMs
          ) {
            events.push(parsed.data);
          }
        } catch {
          // Torn/foreign line: skip.
        }
      }
    }
    return events;
  }

  private currentFilePath(): string {
    if (!this.usageDir) {
      throw new Error("Usage recorder not initialized");
    }
    return path.join(this.usageDir, CURRENT_FILE_NAME);
  }

  private enqueue(event: UsageEventT): void {
    const line = `${JSON.stringify(event)}\n`;
    if (!this.usageDir && this.pendingLines.length >= MAX_PENDING_LINES) {
      this.pendingLines.shift();
      this.droppedBeforeInit += 1;
    }
    this.pendingLines.push(line);
    if (this.usageDir) {
      this.scheduleFlush();
    }
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

  private async flushNow(): Promise<void> {
    // Serialize flushes so rotation and append never interleave.
    this.flushChain = this.flushChain.then(() => this.writePending());
    await this.flushChain;
  }

  private async writePending(): Promise<void> {
    if (!this.usageDir || this.pendingLines.length === 0) {
      return;
    }
    const lines = this.pendingLines;
    this.pendingLines = [];
    const chunk = lines.join("");
    try {
      if (this.approxCurrentBytes + chunk.length > this.maxFileBytes) {
        await this.rotate();
      }
      await fs.appendFile(this.currentFilePath(), chunk, "utf8");
      this.approxCurrentBytes += chunk.length;
      this.writeFailureLogged = false;
    } catch (error) {
      // Usage data is best-effort: losing lines must never affect the bridge.
      if (!this.writeFailureLogged) {
        this.writeFailureLogged = true;
        const message = error instanceof Error ? error.message : String(error);
        this.tryLogger()?.warn(
          `[Intelligence] Usage log write failed (dropping events until recovery): ${message}`,
        );
      }
    }
  }

  private async rotate(): Promise<void> {
    if (!this.usageDir) {
      return;
    }
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
    const rotatedPath = path.join(
      this.usageDir,
      `${ROTATED_FILE_PREFIX}${stamp}${ROTATED_FILE_SUFFIX}`,
    );
    try {
      await fs.rename(this.currentFilePath(), rotatedPath);
    } catch {
      // Missing current file: nothing to rotate.
    }
    this.approxCurrentBytes = 0;
    await this.pruneRotated();
  }

  private async pruneRotated(): Promise<void> {
    if (!this.usageDir) {
      return;
    }
    try {
      const entries = await fs.readdir(this.usageDir);
      const rotated = entries
        .filter(
          (name) =>
            name.startsWith(ROTATED_FILE_PREFIX) &&
            name.endsWith(ROTATED_FILE_SUFFIX) &&
            name !== CURRENT_FILE_NAME,
        )
        .sort();
      const excess = rotated.slice(
        0,
        Math.max(0, rotated.length - this.maxRotatedFiles),
      );
      await Promise.all(
        excess.map((name) =>
          fs.rm(path.join(this.usageDir as string, name), { force: true }),
        ),
      );
    } catch {
      // Pruning is best-effort.
    }
  }

  private tryLogger(): LoggerLikeT | null {
    try {
      return getBridgeContext().logger;
    } catch {
      return null;
    }
  }
}

export const graphicsUsageRecorder = new GraphicsUsageRecorder();
