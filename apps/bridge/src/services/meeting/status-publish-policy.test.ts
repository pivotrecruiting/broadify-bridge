import {
  decideStatusPublish,
  projectStableStatus,
  STATUS_METRICS_PUBLISH_INTERVAL_MS,
} from "./status-publish-policy.js";

function makeStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manager: { state: "running", pid: 1 },
    engine: {
      active_camera_index: 0,
      rendered_frames: 100,
      reused_frames: 5,
      published_preview_frames: 90,
      written_framebus_frames: 100,
    },
    framebus: { running: true, name: "bfy-meet" },
    keyer: {
      status: {
        provider: "coreml",
        inference_ms: 12.5,
        metrics: { keyer_fps: 29.9, dropped_frames: 3 },
      },
    },
    recording: { active: false, elapsed_seconds: 0, video_frames: 0 },
    virtualCamera: { active: false },
    ...overrides,
  };
}

describe("status-publish-policy", () => {
  it("projection ignores per-frame counters and keyer metrics", () => {
    const a = projectStableStatus(makeStatus());
    const b = projectStableStatus(
      makeStatus({
        engine: {
          active_camera_index: 0,
          rendered_frames: 200,
          reused_frames: 50,
          published_preview_frames: 180,
          written_framebus_frames: 200,
        },
        keyer: {
          status: {
            provider: "coreml",
            inference_ms: 40,
            metrics: { keyer_fps: 12, dropped_frames: 99 },
          },
        },
      }),
    );
    expect(a).toBe(b);
    expect(a).not.toContain("rendered_frames");
    expect(a).not.toContain("keyer_fps");
    expect(a).toContain("coreml");
  });

  it("skips an identical projection inside the metrics interval", () => {
    const first = decideStatusPublish({
      status: makeStatus(),
      force: false,
      lastProjection: null,
      lastPublishedAt: null,
      now: 10_000,
    });
    expect(first.publish).toBe(true);
    expect(first.reason).toBe("projection_changed");

    const second = decideStatusPublish({
      status: makeStatus({ engine: { active_camera_index: 0, rendered_frames: 999 } }),
      force: false,
      lastProjection: first.projection,
      lastPublishedAt: 10_000,
      now: 12_000,
    });
    expect(second.publish).toBe(false);
    expect(second.reason).toBe("unchanged");
  });

  it("publishes a metrics-only change once the interval elapsed", () => {
    const first = decideStatusPublish({
      status: makeStatus(),
      force: false,
      lastProjection: null,
      lastPublishedAt: null,
      now: 10_000,
    });
    const later = decideStatusPublish({
      status: makeStatus(),
      force: false,
      lastProjection: first.projection,
      lastPublishedAt: 10_000,
      now: 10_000 + STATUS_METRICS_PUBLISH_INTERVAL_MS,
    });
    expect(later.publish).toBe(true);
    expect(later.reason).toBe("metrics_interval");
  });

  it("always publishes while a recording is active", () => {
    const status = makeStatus({
      recording: { active: true, elapsed_seconds: 4, video_frames: 120 },
    });
    const projection = projectStableStatus(status);
    const decision = decideStatusPublish({
      status: { ...status, recording: { active: true, elapsed_seconds: 5, video_frames: 150 } },
      force: false,
      lastProjection: projection,
      lastPublishedAt: 10_000,
      now: 12_000,
    });
    expect(decision.publish).toBe(true);
    expect(decision.reason).toBe("recording_active");
  });

  it("force always publishes", () => {
    const status = makeStatus();
    const decision = decideStatusPublish({
      status,
      force: true,
      lastProjection: projectStableStatus(status),
      lastPublishedAt: 10_000,
      now: 10_001,
    });
    expect(decision.publish).toBe(true);
    expect(decision.reason).toBe("forced");
  });

  it("publishes immediately on a state change", () => {
    const status = makeStatus();
    const decision = decideStatusPublish({
      status: makeStatus({
        keyer: { status: { provider: "vision", inference_ms: 1, metrics: {} } },
      }),
      force: false,
      lastProjection: projectStableStatus(status),
      lastPublishedAt: 10_000,
      now: 10_001,
    });
    expect(decision.publish).toBe(true);
    expect(decision.reason).toBe("projection_changed");
  });
});
