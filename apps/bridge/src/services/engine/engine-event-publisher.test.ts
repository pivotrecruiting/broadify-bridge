import { setBridgeContext } from "../bridge-context.js";
import {
  publishEngineErrorEvent,
  publishEngineMacroExecutionEvent,
  publishEngineStatusEvent,
} from "./engine-event-publisher.js";
import type { EngineStateT } from "../engine-types.js";

describe("engine-event-publisher", () => {
  const mockPublishBridgeEvent = jest.fn();
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const state: EngineStateT = {
    status: "connected",
    type: "atem",
    ip: "10.0.0.10",
    port: 9910,
    macros: [{ id: 1, name: "Macro 1", status: "running" }],
    macroExecution: {
      runId: "run-1",
      macroId: 1,
      macroName: "Macro 1",
      engineType: "atem",
      status: "running",
      triggeredAt: 100,
      startedAt: 110,
      waitingAt: null,
      completedAt: null,
      actualDurationMs: null,
      loop: false,
      stopRequestedAt: null,
    },
    lastCompletedMacroExecution: null,
    lastUpdate: 123,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    setBridgeContext({
      userDataDir: "/tmp",
      logPath: "/tmp/bridge.log",
      logger: mockLogger,
      publishBridgeEvent: mockPublishBridgeEvent,
    });
  });

  it("publishes engine_status event with engine snapshot", () => {
    publishEngineStatusEvent("macro_execution_changed", state);

    expect(mockPublishBridgeEvent).toHaveBeenCalledWith({
      event: "engine_status",
      data: {
        reason: "macro_execution_changed",
        status: "connected",
        type: "atem",
        ip: "10.0.0.10",
        port: 9910,
        macros: state.macros,
        macroExecution: state.macroExecution,
        lastCompletedMacroExecution: null,
        error: null,
        lastUpdate: 123,
      },
    });
    expect(mockLogger.debug).toHaveBeenCalledWith(
      "[Engine] Publish status: macro_execution_changed"
    );
  });

  it("publishes engine_macro_execution event with execution state", () => {
    publishEngineMacroExecutionEvent("execution_changed", state);

    expect(mockPublishBridgeEvent).toHaveBeenCalledWith({
      event: "engine_macro_execution",
      data: {
        reason: "execution_changed",
        execution: state.macroExecution,
        lastCompletedExecution: null,
      },
    });
    expect(mockLogger.debug).toHaveBeenCalledWith(
      "[Engine] Publish macro execution: execution_changed"
    );
  });

  it("publishes engine_error event and logs", () => {
    publishEngineErrorEvent("connection_failed", "dial failed");

    expect(mockPublishBridgeEvent).toHaveBeenCalledWith({
      event: "engine_error",
      data: {
        code: "connection_failed",
        message: "dial failed",
      },
    });
    expect(mockLogger.error).toHaveBeenCalledWith(
      "[Engine] Error reported: connection_failed dial failed"
    );
  });

  it("does nothing when publishBridgeEvent is not set", () => {
    setBridgeContext({
      userDataDir: "/tmp",
      logPath: "/tmp/bridge.log",
      logger: mockLogger,
      publishBridgeEvent: undefined,
    });

    publishEngineStatusEvent("test", state);
    publishEngineMacroExecutionEvent("test", state);
    publishEngineErrorEvent("test", "message");

    expect(mockPublishBridgeEvent).not.toHaveBeenCalled();
  });
});
