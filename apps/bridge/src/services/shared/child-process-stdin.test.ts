import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  BENIGN_STDIN_ERROR_CODES,
  attachChildStdinErrorHandler,
  writeChildStdin,
} from "./child-process-stdin.js";

type MockStdinT = EventEmitter & {
  writable: boolean;
  write: jest.Mock;
  end: jest.Mock;
};

function createStdin(overrides: Partial<MockStdinT> = {}): MockStdinT {
  return Object.assign(new EventEmitter(), {
    writable: true,
    write: jest.fn().mockReturnValue(true),
    end: jest.fn(),
    ...overrides,
  }) as MockStdinT;
}

function createChild(stdin: MockStdinT | null): ChildProcess & { stdin: MockStdinT | null } {
  return { stdin } as unknown as ChildProcess & { stdin: MockStdinT | null };
}

const createLogger = () => ({ debug: jest.fn(), warn: jest.fn() });

const errorWithCode = (code: string) =>
  Object.assign(new Error(`write ${code}`), { code });

describe("attachChildStdinErrorHandler", () => {
  it.each([...BENIGN_STDIN_ERROR_CODES])(
    "logs %s at debug instead of throwing",
    (code) => {
      const stdin = createStdin();
      const logger = createLogger();
      attachChildStdinErrorHandler(createChild(stdin), "TestHelper", logger);

      expect(() => stdin.emit("error", errorWithCode(code))).not.toThrow();
      expect(logger.debug).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining(code));
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("[TestHelper]"));
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it("logs other error codes at warn", () => {
    const stdin = createStdin();
    const logger = createLogger();
    attachChildStdinErrorHandler(createChild(stdin), "TestHelper", logger);

    expect(() => stdin.emit("error", errorWithCode("EIO"))).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("EIO"));
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("logs errors without a code at warn", () => {
    const stdin = createStdin();
    const logger = createLogger();
    attachChildStdinErrorHandler(createChild(stdin), "TestHelper", logger);

    expect(() => stdin.emit("error", new Error("boom"))).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("is idempotent: a second attach adds no listener", () => {
    const stdin = createStdin();
    const logger = createLogger();
    const child = createChild(stdin);

    attachChildStdinErrorHandler(child, "TestHelper", logger);
    attachChildStdinErrorHandler(child, "TestHelper", logger);

    expect(stdin.listenerCount("error")).toBe(1);
    stdin.emit("error", errorWithCode("EPIPE"));
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  it("tolerates a child without stdin", () => {
    const logger = createLogger();
    expect(() =>
      attachChildStdinErrorHandler(createChild(null), "TestHelper", logger),
    ).not.toThrow();
  });

  it("does not throw when the logger has no debug method", () => {
    const stdin = createStdin();
    const logger = { warn: jest.fn() };
    attachChildStdinErrorHandler(createChild(stdin), "TestHelper", logger);

    expect(() => stdin.emit("error", errorWithCode("EPIPE"))).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("writeChildStdin", () => {
  it("writes to a writable stdin and returns true", () => {
    const stdin = createStdin();
    const logger = createLogger();

    const result = writeChildStdin(createChild(stdin), "payload\n", "TestHelper", logger);

    expect(result).toBe(true);
    expect(stdin.write).toHaveBeenCalledWith("payload\n");
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("returns false and logs at debug when stdin is missing", () => {
    const logger = createLogger();

    const result = writeChildStdin(createChild(null), "payload\n", "TestHelper", logger);

    expect(result).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("[TestHelper]"));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns false without writing when stdin is not writable", () => {
    const stdin = createStdin({ writable: false });
    const logger = createLogger();

    const result = writeChildStdin(createChild(stdin), "payload\n", "TestHelper", logger);

    expect(result).toBe(false);
    expect(stdin.write).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  it("returns false when write throws synchronously", () => {
    const stdin = createStdin();
    stdin.write.mockImplementation(() => {
      throw errorWithCode("EPIPE");
    });
    const logger = createLogger();

    expect(() =>
      writeChildStdin(createChild(stdin), "payload\n", "TestHelper", logger),
    ).not.toThrow();
    expect(writeChildStdin(createChild(stdin), "payload\n", "TestHelper", logger)).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("EPIPE"));
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
