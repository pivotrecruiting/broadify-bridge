import { EngineMacroExecutionStore } from "./engine-macro-execution-store.js";

describe("EngineMacroExecutionStore", () => {
  let store: EngineMacroExecutionStore;

  beforeEach(() => {
    store = new EngineMacroExecutionStore();
  });

  it("starts a pending execution", () => {
    const execution = store.startPending({
      macroId: 3,
      macroName: "Macro 3",
      engineType: "atem",
      now: () => 100,
      runIdFactory: () => "run-1",
    });

    expect(execution).toEqual({
      runId: "run-1",
      macroId: 3,
      macroName: "Macro 3",
      engineType: "atem",
      status: "pending",
      triggeredAt: 100,
      acceptedAt: null,
      startedAt: null,
      waitingAt: null,
      completedAt: null,
      actualDurationMs: null,
      loop: false,
      stopRequestedAt: null,
    });
  });

  it("transitions pending to running", () => {
    store.startPending({
      macroId: 3,
      engineType: "atem",
      now: () => 100,
      runIdFactory: () => "run-1",
    });

    const execution = store.markDeviceState({
      macroId: 3,
      macroName: "Macro 3",
      engineType: "atem",
      status: "running",
      loop: false,
      now: () => 120,
    });

    expect(execution).toMatchObject({
      runId: "run-1",
      macroId: 3,
      status: "running",
      startedAt: 120,
      waitingAt: null,
      loop: false,
    });
  });

  it("transitions running to waiting", () => {
    store.startPending({
      macroId: 2,
      engineType: "atem",
      now: () => 100,
      runIdFactory: () => "run-2",
    });
    store.markDeviceState({
      macroId: 2,
      engineType: "atem",
      status: "running",
      loop: false,
      now: () => 110,
    });

    const execution = store.markDeviceState({
      macroId: 2,
      engineType: "atem",
      status: "waiting",
      loop: false,
      now: () => 150,
    });

    expect(execution).toMatchObject({
      runId: "run-2",
      status: "waiting",
      startedAt: 110,
      waitingAt: 150,
    });
  });

  it("completes a running execution and stores duration", () => {
    store.startPending({
      macroId: 5,
      engineType: "atem",
      now: () => 100,
      runIdFactory: () => "run-5",
    });
    store.markDeviceState({
      macroId: 5,
      engineType: "atem",
      status: "running",
      loop: false,
      now: () => 125,
    });

    const completed = store.markInactive(() => 225);

    expect(completed).toMatchObject({
      runId: "run-5",
      status: "completed",
      completedAt: 225,
      actualDurationMs: 100,
    });
    expect(store.getActiveExecution()).toBeNull();
    expect(store.getLastCompletedExecution()).toMatchObject({
      runId: "run-5",
      status: "completed",
    });
  });

  it("marks a stopped execution when stop was requested", () => {
    store.startPending({
      macroId: 1,
      engineType: "atem",
      now: () => 10,
      runIdFactory: () => "run-stop",
    });
    store.markDeviceState({
      macroId: 1,
      engineType: "atem",
      status: "running",
      loop: false,
      now: () => 20,
    });
    store.requestStop(() => 30);

    const completed = store.markInactive(() => 60);

    expect(completed).toMatchObject({
      runId: "run-stop",
      status: "stopped",
      stopRequestedAt: 30,
      actualDurationMs: 40,
    });
  });

  it("keeps pending execution active while no device confirmation exists", () => {
    store.startPending({
      macroId: 9,
      engineType: "atem",
      now: () => 10,
      runIdFactory: () => "run-pending",
    });

    const execution = store.markInactive(() => 50);

    expect(execution).toMatchObject({
      runId: "run-pending",
      status: "pending",
    });
    expect(store.getActiveExecution()).toMatchObject({
      runId: "run-pending",
      status: "pending",
    });
    expect(store.getLastCompletedExecution()).toBeNull();
  });

  it("completes an accepted pending execution without a device running state", () => {
    store.startPending({
      macroId: 9,
      engineType: "atem",
      now: () => 10,
      runIdFactory: () => "run-fast",
    });

    const accepted = store.markAccepted(() => 20);
    const completed = store.markInactive(() => 50);

    expect(accepted).toMatchObject({
      runId: "run-fast",
      status: "pending",
      acceptedAt: 20,
    });
    expect(completed).toMatchObject({
      runId: "run-fast",
      status: "completed",
      triggeredAt: 10,
      acceptedAt: 20,
      startedAt: null,
      completedAt: 50,
      actualDurationMs: null,
    });
    expect(store.getActiveExecution()).toBeNull();
    expect(store.getLastCompletedExecution()).toMatchObject({
      runId: "run-fast",
      status: "completed",
    });
  });

  it("marks an active execution as failed", () => {
    store.startPending({
      macroId: 4,
      engineType: "atem",
      now: () => 100,
      runIdFactory: () => "run-failed",
    });
    store.markDeviceState({
      macroId: 4,
      engineType: "atem",
      status: "running",
      loop: false,
      now: () => 125,
    });

    const failed = store.fail("boom", () => 175);

    expect(failed).toMatchObject({
      runId: "run-failed",
      status: "failed",
      error: "boom",
      completedAt: 175,
      actualDurationMs: 50,
    });
    expect(store.getLastCompletedExecution()).toBeNull();
  });
});
