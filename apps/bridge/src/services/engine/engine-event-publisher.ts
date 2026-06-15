import { getBridgeContext } from "../bridge-context.js";
import type { EngineStateT } from "../engine-types.js";

/**
 * Publish current engine status over bridge events.
 *
 * @param reason Status update reason.
 * @param state Current engine state snapshot.
 */
export function publishEngineStatusEvent(
  reason: string,
  state: EngineStateT
): void {
  const publishBridgeEvent = getBridgeContext().publishBridgeEvent;
  if (!publishBridgeEvent) {
    return;
  }

  getBridgeContext().logger.debug?.(`[Engine] Publish status: ${reason}`);
  publishBridgeEvent({
    event: "engine_status",
    data: {
      reason,
      status: state.status,
      type: state.type,
      ip: state.ip,
      port: state.port,
      macros: state.macros,
      macroExecution: state.macroExecution ?? null,
      lastCompletedMacroExecution: state.lastCompletedMacroExecution ?? null,
      error: state.error ?? null,
      lastUpdate: state.lastUpdate ?? null,
    },
  });
}

/**
 * Publish engine macro execution updates over bridge events.
 *
 * @param reason Execution update reason.
 * @param state Current engine state snapshot.
 */
export function publishEngineMacroExecutionEvent(
  reason: string,
  state: EngineStateT
): void {
  const publishBridgeEvent = getBridgeContext().publishBridgeEvent;
  if (!publishBridgeEvent) {
    return;
  }

  getBridgeContext().logger.debug?.(
    `[Engine] Publish macro execution: ${reason}`
  );
  publishBridgeEvent({
    event: "engine_macro_execution",
    data: {
      reason,
      execution: state.macroExecution ?? null,
      lastCompletedExecution: state.lastCompletedMacroExecution ?? null,
    },
  });
}

/**
 * Publish engine errors over bridge events.
 *
 * @param code Error code.
 * @param message Error message.
 */
export function publishEngineErrorEvent(code: string, message: string): void {
  const publishBridgeEvent = getBridgeContext().publishBridgeEvent;
  if (!publishBridgeEvent) {
    return;
  }

  getBridgeContext().logger.error(`[Engine] Error reported: ${code} ${message}`);
  publishBridgeEvent({
    event: "engine_error",
    data: {
      code,
      message,
    },
  });
}
