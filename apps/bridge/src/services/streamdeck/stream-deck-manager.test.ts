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
