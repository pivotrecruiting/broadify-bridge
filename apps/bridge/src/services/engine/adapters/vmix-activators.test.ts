import { LineSplitter, activatorToEvents, createVmixActivatorState, parseActivatorLine } from "./vmix-activators.js";

describe("vmix activators", () => {
  test("parses the ACTS feed and ignores noise", () => {
    expect(parseActivatorLine("ACTS OK Input 3 1\r")).toEqual({ activator: "Input", input: 3, value: 1 });
    expect(parseActivatorLine("SUBSCRIBE OK ACTS")).toBeNull();
    expect(parseActivatorLine("ACTS OK Input x 1")).toBeNull();
  });

  test("maps program, preview, overlays, recording and streaming with de-duplication", () => {
    const state = createVmixActivatorState();
    const names = (n: number) => (n === 3 ? "Cam 3" : null);
    const run = (line: string) => activatorToEvents(parseActivatorLine(line)!, state, names);
    expect(run("ACTS OK Input 1 0")).toEqual([]);
    expect(run("ACTS OK Input 3 1")).toEqual([{ type: "program_changed", source: "vmix", me: 0, input_id: "3", input_name: "Cam 3" }]);
    expect(run("ACTS OK Input 3 1")).toEqual([]);
    expect(run("ACTS OK InputPreview 2 1")).toMatchObject([{ type: "preview_changed", input_id: "2" }]);
    expect(run("ACTS OK Overlay1 5 1")).toMatchObject([{ type: "overlay_on_air", keyer: "overlay1", input_id: "5" }]);
    expect(run("ACTS OK Overlay1 5 0")).toMatchObject([{ type: "overlay_off_air", keyer: "overlay1", input_id: "5" }]);
    expect(run("ACTS OK Overlay1 5 0")).toEqual([]);
    expect(run("ACTS OK Recording 0 1")).toEqual([{ type: "recording_started", source: "vmix" }]);
    expect(run("ACTS OK Recording 0 1")).toEqual([]);
    expect(run("ACTS OK Recording 0 0")).toEqual([{ type: "recording_stopped", source: "vmix" }]);
    expect(run("ACTS OK Streaming 0 1")).toEqual([{ type: "streaming_started", source: "vmix" }]);
    expect(run("ACTS OK Fullscreen 0 1")).toEqual([]);
  });

  test("line splitter keeps partial lines", () => {
    const splitter = new LineSplitter();
    expect(splitter.push("ACTS OK Input 1 1\r\nACTS OK Inp")).toEqual(["ACTS OK Input 1 1"]);
    expect(splitter.push("ut 2 1\r\n")).toEqual(["ACTS OK Input 2 1"]);
  });
});
