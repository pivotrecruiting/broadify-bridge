import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setBridgeContext } from "../bridge-context.js";
import { UsageEventSchema, type UsageEventT } from "./intelligence-types.js";
import { GraphicsUsageRecorder } from "./usage-event-recorder.js";

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let userDataDir: string;

function usageFilePath(): string {
  return path.join(userDataDir, "intelligence", "usage", "usage-current.jsonl");
}

async function readEvents(filePath = usageFilePath()): Promise<UsageEventT[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => UsageEventSchema.parse(JSON.parse(line)));
}

async function createRecorder(
  options: ConstructorParameters<typeof GraphicsUsageRecorder>[0] = {},
): Promise<GraphicsUsageRecorder> {
  const recorder = new GraphicsUsageRecorder({ flushDelayMs: 1, ...options });
  await recorder.initialize();
  return recorder;
}

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-recorder-"));
  setBridgeContext({
    userDataDir,
    logger: noopLogger,
    logPath: path.join(userDataDir, "bridge.log"),
  });
});

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true });
});

describe("GraphicsUsageRecorder", () => {
  it("writes schema-valid shown/hidden pairs", async () => {
    const recorder = await createRecorder();
    recorder.recordLayerShown({
      source: "studio",
      layerId: "lower-third-abc",
      category: "lower-third",
      presetId: "preset-1",
    });
    recorder.recordLayerHidden({
      source: "studio",
      layerId: "lower-third-abc",
      reason: "remove_layer",
    });
    await recorder.shutdown();

    const events = await readEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "graphic_shown",
      source: "studio",
      layer_id: "lower-third-abc",
      category: "lower-third",
      preset_id: "preset-1",
    });
    expect(events[1]).toMatchObject({
      type: "graphic_hidden",
      layer_id: "lower-third-abc",
      reason: "remove_layer",
    });
  });

  it("treats identical re-sends as a continuation (no extra events)", async () => {
    const recorder = await createRecorder();
    const input = {
      source: "meeting-back",
      layerId: "meeting-background-template",
      category: "background",
    };
    recorder.recordLayerShown(input);
    recorder.recordLayerShown(input);
    recorder.recordLayerShown(input);
    await recorder.shutdown();

    const events = await readEvents();
    // One shown + the shutdown close-out, despite three sends.
    expect(events.map((event) => event.type)).toEqual([
      "graphic_shown",
      "graphic_hidden",
    ]);
  });

  it("closes and reopens the interval when the identity changes", async () => {
    const recorder = await createRecorder();
    recorder.recordLayerShown({
      source: "meeting-front",
      layerId: "meeting-session-1-preset-names",
      category: "names",
      reportPresetId: "preset-a",
    });
    recorder.recordLayerShown({
      source: "meeting-front",
      layerId: "meeting-session-1-preset-names",
      category: "names",
      reportPresetId: "preset-b",
    });
    recorder.recordLayerHidden({
      source: "meeting-front",
      layerId: "meeting-session-1-preset-names",
      reason: "remove_layer",
    });
    await recorder.shutdown();

    const events = await readEvents();
    expect(events.map((event) => event.type)).toEqual([
      "graphic_shown",
      "graphic_hidden",
      "graphic_shown",
      "graphic_hidden",
    ]);
    expect(events[1]).toMatchObject({ reason: "replaced" });
    expect(events[3]).toMatchObject({ reason: "remove_layer" });
  });

  it("ignores hidden for layers that never opened", async () => {
    const recorder = await createRecorder();
    recorder.recordLayerHidden({
      source: "studio",
      layerId: "ghost",
      reason: "remove_layer",
    });
    await recorder.shutdown();

    await expect(fs.readFile(usageFilePath(), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps per-source intervals apart", async () => {
    const recorder = await createRecorder();
    recorder.recordLayerShown({
      source: "meeting-back",
      layerId: "shared-id",
      category: "background",
    });
    recorder.recordLayerShown({
      source: "meeting-front",
      layerId: "shared-id",
      category: "names",
    });
    recorder.recordLayerHidden({
      source: "meeting-back",
      layerId: "shared-id",
      reason: "remove_layer",
    });
    await recorder.shutdown();

    const events = await readEvents();
    const hidden = events.filter((event) => event.type === "graphic_hidden");
    expect(hidden).toHaveLength(2);
    expect(hidden[0]).toMatchObject({
      source: "meeting-back",
      reason: "remove_layer",
    });
    expect(hidden[1]).toMatchObject({
      source: "meeting-front",
      reason: "shutdown",
    });
  });

  it("records call markers", async () => {
    const recorder = await createRecorder();
    recorder.recordCallStarted("call-1", 1000);
    recorder.recordCallEnded("call-1", "clients_gone", 2000);
    await recorder.shutdown();

    const events = await readEvents();
    expect(events).toEqual([
      { v: 1, type: "call_started", at: 1000, call_id: "call-1" },
      {
        v: 1,
        type: "call_ended",
        at: 2000,
        call_id: "call-1",
        reason: "clients_gone",
      },
    ]);
  });

  it("buffers events recorded before initialize and flushes them after", async () => {
    const recorder = new GraphicsUsageRecorder({ flushDelayMs: 1 });
    recorder.recordCallStarted("early-call", 500);
    await recorder.initialize();
    await recorder.shutdown();

    const events = await readEvents();
    expect(events).toEqual([
      { v: 1, type: "call_started", at: 500, call_id: "early-call" },
    ]);
  });

  it("rotates the current file beyond the size limit and prunes old files", async () => {
    const recorder = await createRecorder({
      maxFileBytes: 200,
      maxRotatedFiles: 1,
    });
    for (let i = 0; i < 30; i += 1) {
      recorder.recordCallStarted(`call-${i}`, i);
      // Flush per event so the size check runs between appends.
      await recorder.shutdown();
    }

    const dir = path.join(userDataDir, "intelligence", "usage");
    const entries = await fs.readdir(dir);
    const rotated = entries.filter((name) => name !== "usage-current.jsonl");
    expect(rotated.length).toBeLessThanOrEqual(1);
    expect(entries).toContain("usage-current.jsonl");
    // Every surviving line is still schema-valid.
    for (const name of entries) {
      const events = await readEvents(path.join(dir, name));
      expect(events.length).toBeGreaterThan(0);
    }
  });
});
