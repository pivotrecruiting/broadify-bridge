import { drainLines, parseRendererLogLine } from "./renderer-log-parser.js";

describe("renderer-log-parser", () => {
  describe("drainLines", () => {
    it("returns complete lines and remainder without trailing newline", () => {
      const result = drainLines("line1\nline2\nline3");
      expect(result.lines).toEqual(["line1", "line2"]);
      expect(result.remainder).toBe("line3");
    });

    it("returns all lines when buffer ends with newline", () => {
      const result = drainLines("line1\nline2\nline3\n");
      expect(result.lines).toEqual(["line1", "line2", "line3"]);
      expect(result.remainder).toBe("");
    });

    it("keeps partial line in remainder", () => {
      const result = drainLines("line1\nline2\npartial");
      expect(result.lines).toEqual(["line1", "line2"]);
      expect(result.remainder).toBe("partial");
    });

    it("skips empty lines", () => {
      const result = drainLines("a\n\nb\n\n");
      expect(result.lines).toEqual(["a", "b"]);
      expect(result.remainder).toBe("");
    });

    it("trims lines", () => {
      const result = drainLines("  a  \n  b  ");
      expect(result.lines).toEqual(["a"]);
      expect(result.remainder).toBe("  b  ");
    });

    it("handles empty buffer", () => {
      const result = drainLines("");
      expect(result.lines).toEqual([]);
      expect(result.remainder).toBe("");
    });
  });

  describe("parseRendererLogLine", () => {
    it("parses pino JSON and maps level 50+ to error", () => {
      const line = JSON.stringify({
        level: 50,
        msg: "something failed",
        time: 123,
      });
      const result = parseRendererLogLine(line, "info");
      expect(result.level).toBe("error");
      expect(result.message).toBe("something failed");
      expect(result.context).not.toHaveProperty("level");
      expect(result.context).not.toHaveProperty("msg");
      expect(result.context).not.toHaveProperty("time");
    });

    it("maps level 40-49 to warn", () => {
      const line = JSON.stringify({ level: 40, msg: "warning" });
      const result = parseRendererLogLine(line, "info");
      expect(result.level).toBe("warn");
      expect(result.message).toBe("warning");
    });

    it("maps level 30-39 to info", () => {
      const line = JSON.stringify({ level: 30, msg: "info" });
      const result = parseRendererLogLine(line, "info");
      expect(result.level).toBe("info");
      expect(result.message).toBe("info");
    });

    it("maps level < 30 to debug", () => {
      const line = JSON.stringify({ level: 20, msg: "debug" });
      const result = parseRendererLogLine(line, "info");
      expect(result.level).toBe("debug");
      expect(result.message).toBe("debug");
    });

    it("uses fallback level for non-JSON line", () => {
      const result = parseRendererLogLine("plain text log", "warn");
      expect(result.level).toBe("warn");
      expect(result.message).toBe("plain text log");
      expect(result.context).toEqual({});
    });

    it("uses fallback level and raw line as message when level is not a number", () => {
      const line = JSON.stringify({ level: "info", msg: "test" });
      const result = parseRendererLogLine(line, "error");
      expect(result.level).toBe("error");
      expect(result.message).toBe(line);
      expect(result.context).toEqual({});
    });

    it("uses full line as message when msg is missing", () => {
      const line = JSON.stringify({ level: 30 });
      const result = parseRendererLogLine(line, "info");
      expect(result.message).toBe(line);
    });

    it("preserves extra keys in context", () => {
      const line = JSON.stringify({
        level: 30,
        msg: "ok",
        custom: "value",
        pid: 1,
      });
      const result = parseRendererLogLine(line, "info");
      expect(result.context).toHaveProperty("custom", "value");
      expect(result.context).not.toHaveProperty("pid");
    });
  });
});
