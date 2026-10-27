import { ModeActivationService } from "./mode-activation-service.js";
import { ModeActivationState } from "./mode-activation-state.js";

const createService = () => {
  const state = new ModeActivationState();
  const startEngineAutoConnect = jest.fn();
  const applyPersistedGraphicsOutput = jest.fn().mockResolvedValue(undefined);
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const service = new ModeActivationService({
    state,
    startEngineAutoConnect,
    applyPersistedGraphicsOutput,
    logger,
  });
  return { service, state, startEngineAutoConnect, applyPersistedGraphicsOutput, logger };
};

describe("ModeActivationService", () => {
  it("studio triggers the engine auto-connect and the persisted graphics output", async () => {
    const { service, state, startEngineAutoConnect, applyPersistedGraphicsOutput } =
      createService();

    const result = await service.activate("studio");

    expect(startEngineAutoConnect).toHaveBeenCalledTimes(1);
    expect(applyPersistedGraphicsOutput).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      mode: "studio",
      restored: ["engine_autoconnect", "graphics_output"],
    });
    expect(state.isStudioRestoreActive()).toBe(true);
    expect(state.getActivatedModes()).toEqual(["studio"]);
  });

  it("conference restores the same Studio connections", async () => {
    const { service, state, startEngineAutoConnect, applyPersistedGraphicsOutput } =
      createService();

    const result = await service.activate("conference");

    expect(startEngineAutoConnect).toHaveBeenCalledTimes(1);
    expect(applyPersistedGraphicsOutput).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      mode: "conference",
      restored: ["engine_autoconnect", "graphics_output"],
    });
    expect(state.isStudioRestoreActive()).toBe(true);
  });

  it("meeting restores nothing", async () => {
    const { service, state, startEngineAutoConnect, applyPersistedGraphicsOutput } =
      createService();

    const result = await service.activate("meeting");

    expect(startEngineAutoConnect).not.toHaveBeenCalled();
    expect(applyPersistedGraphicsOutput).not.toHaveBeenCalled();
    expect(result).toEqual({ mode: "meeting", restored: [] });
    expect(state.isStudioRestoreActive()).toBe(false);
    expect(state.getActivatedModes()).toEqual(["meeting"]);
  });

  it("is idempotent: repeated studio activations record the mode once and re-trigger the idempotent restores", async () => {
    const { service, state, startEngineAutoConnect, applyPersistedGraphicsOutput } =
      createService();

    const first = await service.activate("studio");
    const second = await service.activate("studio");

    expect(first).toEqual(second);
    expect(state.getActivatedModes()).toEqual(["studio"]);
    // The restores themselves are idempotent on the engine adapter / graphics
    // manager, so the service simply re-triggers them on every activation.
    expect(startEngineAutoConnect).toHaveBeenCalledTimes(2);
    expect(applyPersistedGraphicsOutput).toHaveBeenCalledTimes(2);
  });

  it("keeps every activated mode in the state set", async () => {
    const { service, state } = createService();

    await service.activate("meeting");
    await service.activate("studio");

    expect(state.getActivatedModes()).toEqual(["meeting", "studio"]);
    expect(state.hasActivatedMode("meeting")).toBe(true);
    expect(state.isStudioRestoreActive()).toBe(true);
  });

  it("awaits the graphics output apply before answering", async () => {
    let release: (() => void) | null = null;
    const { service, applyPersistedGraphicsOutput } = createService();
    applyPersistedGraphicsOutput.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    let settled = false;
    const pending = service.activate("studio").then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release!();
    await pending;
    expect(settled).toBe(true);
  });
});
