import { EventEmitter } from "node:events";

import {
  HELPER_NOT_REACHABLE_CODE,
  MeetingHelperClient,
  MeetingHelperRequestError,
} from "./meeting-helper-client.js";

type FakeSocketT = EventEmitter & {
  write: jest.Mock;
  destroy: jest.Mock;
};

type ConnectScriptT =
  | { kind: "connect_error"; code: string }
  | { kind: "reply" }
  | { kind: "error_after_write"; code: string };

describe("MeetingHelperClient connect retry", () => {
  const net = require("node:net");
  let createConnectionSpy: jest.SpyInstance;

  const scriptConnections = (script: ConnectScriptT[]): void => {
    let index = 0;
    createConnectionSpy = jest
      .spyOn(net, "createConnection")
      .mockImplementation(() => {
        const step = script[Math.min(index, script.length - 1)];
        index += 1;
        const socket = new EventEmitter() as FakeSocketT;
        socket.destroy = jest.fn();
        socket.write = jest.fn((payload: string) => {
          const request = JSON.parse(payload) as { id: string };
          if (step.kind === "reply") {
            process.nextTick(() => {
              socket.emit(
                "data",
                Buffer.from(
                  JSON.stringify({ id: request.id, ok: true, result: { pong: true } }) +
                    "\n",
                ),
              );
            });
          } else if (step.kind === "error_after_write") {
            process.nextTick(() => {
              socket.emit("error", Object.assign(new Error(`write ${step.code}`), { code: step.code }));
            });
          }
          return true;
        });
        process.nextTick(() => {
          if (step.kind === "connect_error") {
            socket.emit(
              "error",
              Object.assign(new Error(`connect ${step.code} \\\\.\\pipe\\x`), { code: step.code }),
            );
            return;
          }
          socket.emit("connect");
        });
        return socket;
      });
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("retries ENOENT during connect on win32 and then succeeds", async () => {
    scriptConnections([
      { kind: "connect_error", code: "ENOENT" },
      { kind: "connect_error", code: "ENOENT" },
      { kind: "reply" },
    ]);
    const client = new MeetingHelperClient("\\\\.\\pipe\\x", 2000, { platform: "win32" });

    await expect(client.pingOrThrow()).resolves.toBe(true);
    expect(createConnectionSpy).toHaveBeenCalledTimes(3);
  });

  it("maps exhausted connect retries to helper_not_reachable with the system code", async () => {
    scriptConnections([{ kind: "connect_error", code: "ENOENT" }]);
    const client = new MeetingHelperClient("\\\\.\\pipe\\x", 2000, { platform: "win32" });

    const error = await client.pingOrThrow().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MeetingHelperRequestError);
    expect((error as MeetingHelperRequestError).code).toBe(HELPER_NOT_REACHABLE_CODE);
    expect((error as MeetingHelperRequestError).message).toContain("ENOENT");
    expect(createConnectionSpy).toHaveBeenCalledTimes(5);
  });

  it("does not retry an error raised after the request was written", async () => {
    scriptConnections([{ kind: "error_after_write", code: "EPIPE" }]);
    const client = new MeetingHelperClient("\\\\.\\pipe\\x", 2000, { platform: "win32" });

    const error = await client.pingOrThrow().catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(MeetingHelperRequestError);
    expect((error as NodeJS.ErrnoException).code).toBe("EPIPE");
    expect(createConnectionSpy).toHaveBeenCalledTimes(1);
  });

  it("does not retry connect errors off win32 but still maps the code", async () => {
    scriptConnections([{ kind: "connect_error", code: "ECONNREFUSED" }]);
    const client = new MeetingHelperClient("/tmp/x.sock", 2000, { platform: "darwin" });

    const error = await client.pingOrThrow().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MeetingHelperRequestError);
    expect((error as MeetingHelperRequestError).code).toBe(HELPER_NOT_REACHABLE_CODE);
    expect((error as MeetingHelperRequestError).message).toContain("ECONNREFUSED");
    expect(createConnectionSpy).toHaveBeenCalledTimes(1);
  });

  it("ping() keeps swallowing connect failures", async () => {
    scriptConnections([{ kind: "connect_error", code: "ENOENT" }]);
    const client = new MeetingHelperClient("/tmp/x.sock", 2000, { platform: "darwin" });

    await expect(client.ping()).resolves.toBe(false);
  });
});
