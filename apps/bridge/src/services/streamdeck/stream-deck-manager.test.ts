import { setBridgeContext } from "../bridge-context.js";
import {
  extractCommandFailure,
  StreamDeckManager,
} from "./stream-deck-manager.js";
import { VirtualStreamDeck } from "./virtual-stream-deck.js";

jest.mock("./key-renderer.js", () => ({
  renderKeyImage: jest.fn(async () => Buffer.alloc(4)),
}));

const flushAsync = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("extractCommandFailure", () => {
  it("returns null for successful router results", () => {
    expect(extractCommandFailure({ success: true, data: {} })).toBeNull();
  });

  it("returns null for unknown result shapes", () => {
    expect(extractCommandFailure(undefined)).toBeNull();
    expect(extractCommandFailure("ok")).toBeNull();
  });

  it("extracts the error message of a failed result", () => {
    expect(
      extractCommandFailure({ success: false, error: "Engine not running" }),
    ).toBe("Engine not running");
  });

  it("falls back to the error code, then a generic marker", () => {
    expect(extractCommandFailure({ success: false, errorCode: "busy" })).toBe(
      "busy",
    );
    expect(extractCommandFailure({ success: false })).toBe("command_failed");
  });
});

describe("StreamDeckManager key failures", () => {
  const publishBridgeEvent = jest.fn();
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const createManagerWithBinding = async (
    executor: (
      command: string,
      payload?: Record<string, unknown>,
    ) => Promise<unknown>,
  ) => {
    const manager = new StreamDeckManager();
    const device = new VirtualStreamDeck();
    manager.setExecutor(executor);
    await manager.start(device);
    await manager.configure({
      pages: [
        {
          keys: {
            0: { command: "meeting_recording_toggle", style: { label: "REC" } },
          },
        },
      ],
    });
    return { manager, device };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    setBridgeContext({
      userDataDir: "/tmp/streamdeck-test-does-not-exist",
      logger,
      logPath: "/tmp/streamdeck-test.log",
      publishBridgeEvent,
    });
  });

  it("surfaces a failed command: last_error, warn log, streamdeck_error event", async () => {
    const executor = jest.fn(async () => ({
      success: false,
      error: "Engine not running",
    }));
    const { manager, device } = await createManagerWithBinding(executor);

    device.press(0);
    await flushAsync();

    expect(executor).toHaveBeenCalledWith("meeting_recording_toggle", undefined);
    expect(manager.status().last_error).toBe(
      "meeting_recording_toggle: Engine not running",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Engine not running"),
    );
    expect(publishBridgeEvent).toHaveBeenCalledWith({
      event: "streamdeck_error",
      data: {
        key_index: 0,
        command: "meeting_recording_toggle",
        error: "Engine not running",
      },
    });
  });

  it("keeps last_error clear and publishes no error for a successful command", async () => {
    const executor = jest.fn(async () => ({ success: true, data: {} }));
    const { manager, device } = await createManagerWithBinding(executor);

    device.press(0);
    await flushAsync();

    expect(manager.status().last_error).toBeNull();
    expect(publishBridgeEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "streamdeck_error" }),
    );
  });

  it("surfaces a throwing executor the same way", async () => {
    const executor = jest.fn(async () => {
      throw new Error("socket closed");
    });
    const { manager, device } = await createManagerWithBinding(executor);

    device.press(0);
    await flushAsync();

    expect(manager.status().last_error).toBe(
      "meeting_recording_toggle: socket closed",
    );
    expect(publishBridgeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "streamdeck_error" }),
    );
  });
});

describe("StreamDeckManager webapp action claims", () => {
  const publishBridgeEvent = jest.fn();
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const createManagerWithWebappBinding = async () => {
    const manager = new StreamDeckManager();
    const device = new VirtualStreamDeck();
    await manager.start(device);
    await manager.configure({
      pages: [
        {
          keys: {
            0: {
              command: "webapp:graphics_preset",
              payload: { presetId: "preset-1" },
              style: { label: "GFX" },
            },
          },
        },
      ],
    });
    return { manager, device };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    setBridgeContext({
      userDataDir: "/tmp/streamdeck-test-does-not-exist",
      logger,
      logPath: "/tmp/streamdeck-test.log",
      publishBridgeEvent,
    });
  });

  const publishedActionIds = (): string[] =>
    publishBridgeEvent.mock.calls
      .map(([message]) => message as { event: string; data: { action_id?: string } })
      .filter((message) => message.event === "streamdeck_action")
      .map((message) => message.data.action_id ?? "");

  it("stamps every published webapp action with a unique action_id", async () => {
    const { manager, device } = await createManagerWithWebappBinding();

    device.press(0);
    await flushAsync();
    // The key is in flight until its action resolves - complete it first.
    const [firstId] = publishedActionIds();
    expect(manager.claimWebappAction(firstId)).toBe(true);
    manager.resolveWebappAction(firstId, true);
    device.press(0);
    await flushAsync();

    const ids = publishedActionIds();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/[0-9a-f-]{36}/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("grants the first claim and denies the second (cross-device arbitration)", async () => {
    const { manager, device } = await createManagerWithWebappBinding();
    device.press(0);
    await flushAsync();
    const [actionId] = publishedActionIds();

    expect(manager.claimWebappAction(actionId)).toBe(true);
    expect(manager.claimWebappAction(actionId)).toBe(false);
  });

  it("denies claims for unknown action ids (a stale tab must never execute)", async () => {
    const { manager } = await createManagerWithWebappBinding();

    expect(manager.claimWebappAction("issued-before-restart")).toBe(false);
  });

  it("ignores further presses on a key while its action is in flight", async () => {
    const { manager, device } = await createManagerWithWebappBinding();

    device.press(0);
    await flushAsync();
    device.press(0);
    await flushAsync();
    expect(publishedActionIds()).toHaveLength(1);

    const [actionId] = publishedActionIds();
    expect(manager.claimWebappAction(actionId)).toBe(true);
    manager.resolveWebappAction(actionId, true);
    device.press(0);
    await flushAsync();
    expect(publishedActionIds()).toHaveLength(2);
  });

  it("flashes the key when no tab claims the action within the window", async () => {
    jest.useFakeTimers();
    try {
      const { manager, device } = await createManagerWithWebappBinding();
      device.press(0);
      await flushAsync();
      const [actionId] = publishedActionIds();

      jest.advanceTimersByTime(5_100);

      expect(publishBridgeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "streamdeck_error",
          data: expect.objectContaining({
            error: expect.stringContaining("not_claimed"),
          }),
        }),
      );
      // The expired action is gone: a late claim is denied.
      expect(manager.claimWebappAction(actionId)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("flashes the key when a claimed action never reports a result", async () => {
    jest.useFakeTimers();
    try {
      const { manager, device } = await createManagerWithWebappBinding();
      device.press(0);
      await flushAsync();
      const [actionId] = publishedActionIds();
      expect(manager.claimWebappAction(actionId)).toBe(true);

      jest.advanceTimersByTime(15_100);

      expect(publishBridgeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "streamdeck_error",
          data: expect.objectContaining({
            error: expect.stringContaining("no_result"),
          }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("reports a failed webapp result on the key and acknowledges idempotently", async () => {
    const { manager, device } = await createManagerWithWebappBinding();
    device.press(0);
    await flushAsync();
    const [actionId] = publishedActionIds();
    expect(manager.claimWebappAction(actionId)).toBe(true);

    expect(manager.resolveWebappAction(actionId, false, "preset_missing")).toEqual({
      acknowledged: true,
    });
    expect(manager.status().last_error).toBe(
      "webapp:graphics_preset: preset_missing",
    );
    expect(publishBridgeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "streamdeck_error" }),
    );

    // A second result for the same id is a no-op.
    expect(manager.resolveWebappAction(actionId, false, "again")).toEqual({
      acknowledged: false,
    });
  });

  it("flashes the key immediately when no relay connection exists", async () => {
    setBridgeContext({
      userDataDir: "/tmp/streamdeck-test-does-not-exist",
      logger,
      logPath: "/tmp/streamdeck-test.log",
      publishBridgeEvent: undefined,
    });
    const { manager, device } = await createManagerWithWebappBinding();

    device.press(0);
    await flushAsync();

    expect(manager.status().last_error).toContain("not_delivered");
  });
});
