import type { SwitcherEventT } from "../../session-log/session-log-types.js";

/**
 * vMix TCP API (port 8099) activator feed, pure part.
 *
 * After `SUBSCRIBE ACTS` vMix pushes one line per state change:
 *   ACTS OK <Activator> <Input> <Value>
 * e.g. `ACTS OK Input 3 1` (input 3 went to program), `ACTS OK InputPreview 2 1`,
 * `ACTS OK Overlay1 5 1` (overlay 1 shows input 5), `ACTS OK Recording 0 1`,
 * `ACTS OK Streaming 0 0`. Input is a 1-based input number (0 where unused).
 * Off transitions (`… 0`) for Input/InputPreview are ignored: the next on
 * transition carries the new program/preview. Everything else is mapped to
 * SessionEventLog events with source "vmix". Unknown activators are ignored.
 */

export type VmixActivatorT = { activator: string; input: number; value: number };

export function parseActivatorLine(line: string): VmixActivatorT | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5 || parts[0] !== "ACTS" || parts[1] !== "OK") {
    return null;
  }
  const input = Number(parts[3]);
  const value = Number(parts[4]);
  if (!Number.isFinite(input) || !Number.isFinite(value)) {
    return null;
  }
  return { activator: parts[2], input, value };
}

export type VmixActivatorStateT = {
  program: number | null;
  preview: number | null;
  overlays: Record<string, number | null>;
  recording: boolean;
  streaming: boolean;
};

export function createVmixActivatorState(): VmixActivatorStateT {
  return { program: null, preview: null, overlays: {}, recording: false, streaming: false };
}

/** Applies one activator to the state and returns the resulting events (mutates `state`). */
export function activatorToEvents(parsed: VmixActivatorT, state: VmixActivatorStateT, inputName?: (input: number) => string | null): SwitcherEventT[] {
  const source = "vmix";
  const name = (input: number) => inputName?.(input) ?? null;
  const { activator, input, value } = parsed;
  const on = value === 1;

  if (activator === "Input") {
    if (!on || state.program === input) {
      return [];
    }
    state.program = input;
    return [{ type: "program_changed", source, me: 0, input_id: String(input), input_name: name(input) }];
  }
  if (activator === "InputPreview") {
    if (!on || state.preview === input) {
      return [];
    }
    state.preview = input;
    return [{ type: "preview_changed", source, me: 0, input_id: String(input), input_name: name(input) }];
  }
  const overlay = /^Overlay(\d)$/.exec(activator);
  if (overlay) {
    const keyer = `overlay${overlay[1]}`;
    const current = state.overlays[keyer] ?? null;
    if (on) {
      if (current === input) {
        return [];
      }
      state.overlays[keyer] = input;
      return [{ type: "overlay_on_air", source, keyer, input_id: String(input), input_name: name(input) }];
    }
    if (current === null || (input !== 0 && current !== input)) {
      return [];
    }
    state.overlays[keyer] = null;
    return [{ type: "overlay_off_air", source, keyer, input_id: String(current), input_name: name(current) }];
  }
  if (activator === "Recording") {
    if (state.recording === on) {
      return [];
    }
    state.recording = on;
    return [{ type: on ? "recording_started" : "recording_stopped", source }];
  }
  if (activator === "Streaming") {
    if (state.streaming === on) {
      return [];
    }
    state.streaming = on;
    return [{ type: on ? "streaming_started" : "streaming_stopped", source }];
  }
  return [];
}

/** Splits a TCP chunk stream into complete CRLF/LF lines; keeps the remainder. */
export class LineSplitter {
  private rest = "";

  push(chunk: string): string[] {
    const data = this.rest + chunk;
    const lines = data.split(/\r?\n/);
    this.rest = lines.pop() ?? "";
    return lines.filter((line) => line.length > 0);
  }
}
