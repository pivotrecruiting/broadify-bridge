import { ReconnectScheduler } from "../shared/backoff.js";
import { GraphicsOutputSupervisor } from "./graphics-output-supervisor.js";
import type { GraphicsOutputConfigT } from "./graphics-schemas.js";

const createConfig = (): GraphicsOutputConfigT => ({
  version: 1,
  outputKey: "video_sdi",
  targets: { output1Id: "decklink-1-sdi" },
  format: { width: 1920, height: 1080, fps: 50 },
  range: "legal",
  colorspace: "auto",
});

describe("GraphicsOutputSupervisor", () => {
  const createSupervisor = (overrides: Partial<ConstructorParameters<typeof GraphicsOutputSupervisor>[0]> = {}) => {
    let deviceListener:
      | ((change: { moduleName: string; added: string[]; removed: string[]; devices: unknown[] }) => void)
      | null = null;
    const deps = {
      reapply: jest.fn(async () => undefined),
      subscribeDevices: jest.fn((listener) => {
        deviceListener = listener;
        return () => {
          deviceListener = null;
        };
      }),
      createScheduler: () =>
        new ReconnectScheduler({
          baseMs: 100,
          maxMs: 200,
          jitterRatio: 0,
          maxAttempts: 3,
        }),
      isTargetPresent: jest.fn(() => false),
      publishStatus: jest.fn(),
      logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      now: jest.fn(() => Date.now()),
      ...overrides,
    };
    return {
      supervisor: new GraphicsOutputSupervisor(deps),
      deps,
      emitDeviceChange: (added: string[]) =>
        deviceListener?.({
          moduleName: "decklink",
          added,
          removed: [],
          devices: [],
        }),
    };
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("retries with capped backoff until success", async () => {
    const config = createConfig();
    const { supervisor, deps } = createSupervisor();
    deps.reapply
      .mockRejectedValueOnce(new Error("no device"))
      .mockRejectedValueOnce(new Error("still no device"))
      .mockResolvedValueOnce(undefined);

    supervisor.start({ reason: "init_failed", config });
    await jest.advanceTimersByTimeAsync(100);
    await jest.advanceTimersByTimeAsync(200);
    await jest.advanceTimersByTimeAsync(200);

    expect(deps.reapply).toHaveBeenCalledTimes(3);
    expect(supervisor.getState().active).toBe(false);
  });

  it("stops after maxAttempts and waits for device changes", async () => {
    const { supervisor, deps } = createSupervisor();
    deps.reapply.mockRejectedValue(new Error("no device"));

    supervisor.start({ reason: "init_failed", config: createConfig() });
    await jest.advanceTimersByTimeAsync(100);
    await jest.advanceTimersByTimeAsync(200);
    await jest.advanceTimersByTimeAsync(200);
    await jest.advanceTimersByTimeAsync(1_000);

    expect(deps.reapply).toHaveBeenCalledTimes(3);
    expect(supervisor.getState()).toMatchObject({ active: true, attempt: 3 });
  });

  it("reapplies immediately when the target device reappears", async () => {
    const { supervisor, deps, emitDeviceChange } = createSupervisor({
      isTargetPresent: jest.fn(() => true),
    });
    deps.reapply.mockRejectedValue(new Error("no device"));

    supervisor.start({ reason: "device_changed", config: createConfig() });
    await jest.advanceTimersByTimeAsync(100);
    emitDeviceChange(["decklink-1-sdi"]);
    await Promise.resolve();

    expect(deps.reapply).toHaveBeenCalledTimes(2);
  });

  it("cancel prevents further attempts", async () => {
    const { supervisor, deps } = createSupervisor();

    supervisor.start({ reason: "helper_exit", config: createConfig() });
    supervisor.cancel("manual");
    await jest.advanceTimersByTimeAsync(1_000);

    expect(deps.reapply).not.toHaveBeenCalled();
    expect(supervisor.getState().active).toBe(false);
  });

  it("has no overlapping attempts", async () => {
    let release: (() => void) | null = null;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { supervisor, deps, emitDeviceChange } = createSupervisor({
      reapply: jest.fn(() => pending),
      isTargetPresent: jest.fn(() => true),
    });

    supervisor.start({ reason: "helper_exit", config: createConfig() });
    await jest.advanceTimersByTimeAsync(100);
    emitDeviceChange(["decklink-1-sdi"]);
    await Promise.resolve();

    expect(deps.reapply).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.resolve();
  });
});
