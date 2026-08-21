import { EventEmitter } from "node:events";

const mockOpenVcamHelperApp = jest.fn();
const mockGetVcamHelperStatus = jest.fn();
jest.mock("../../modules/vcam/vcam-helper.js", () => ({
  DEFAULT_MEETING_FRAMEBUS_NAME: "broadify-meeting-framebus",
  openVcamHelperApp: (...args: unknown[]) => mockOpenVcamHelperApp(...args),
  getVcamHelperStatus: (...args: unknown[]) => mockGetVcamHelperStatus(...args),
}));
jest.mock("./vcam-registration-self-heal.js", () => ({
  runVcamStartWithRegistrationSelfHeal: (start: () => Promise<unknown>) => start(),
}));

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

describe("MeetingHelperClient virtual camera output coupling", () => {
  const originalPlatform = process.platform;
  let rpcSpy: jest.SpyInstance;
  let rpcResults: Record<string, unknown>;

  const setPlatform = (platform: NodeJS.Platform): void => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  };

  const calledMethods = (): string[] =>
    rpcSpy.mock.calls.map((call) => call[0] as string);

  beforeEach(() => {
    rpcResults = {
      "output.framebus.status": { enabled: true, running: false, name: "bfy" },
      "output.vcam.raw.start": { enabled: true, running: true },
      "output.vcam.raw.stop": { enabled: true, running: false },
      "output.vcam.start": { ok: true, active: true },
      "output.vcam.stop": { ok: true, active: false },
    };
    rpcSpy = jest
      .spyOn(MeetingHelperClient.prototype as unknown as { rpc: () => unknown }, "rpc")
      .mockImplementation(async (method: unknown) => {
        const result = rpcResults[method as string];
        if (result instanceof Error) throw result;
        return result ?? {};
      });
    mockOpenVcamHelperApp.mockResolvedValue({ available: true, active: true });
    mockGetVcamHelperStatus.mockReturnValue({ available: true, active: false });
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    jest.restoreAllMocks();
    mockOpenVcamHelperApp.mockReset();
    mockGetVcamHelperStatus.mockReset();
  });

  it("darwin: arms the raw stream and reports the framebus status without starting it", async () => {
    setPlatform("darwin");
    const client = new MeetingHelperClient("/tmp/x.sock", 2000, { platform: "darwin" });

    const result = await client.virtualCameraStart();

    expect(calledMethods()).toEqual(["output.framebus.status", "output.vcam.raw.start"]);
    expect(calledMethods()).not.toContain("output.framebus.start");
    expect(mockOpenVcamHelperApp).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      active: true,
      framebus_output: { enabled: true, running: false },
    });
  });

  it("win32: arms the raw stream, creates the camera and never starts the framebus", async () => {
    setPlatform("win32");
    const client = new MeetingHelperClient("\\\\.\\pipe\\x", 2000, { platform: "win32" });

    const result = await client.virtualCameraStart();

    expect(calledMethods()).toEqual([
      "output.framebus.status",
      "output.vcam.raw.start",
      "output.vcam.start",
    ]);
    expect(result).toMatchObject({
      active: true,
      framebus_output: { enabled: true, running: false },
    });
  });

  it("win32: rolls the raw stream back on a failed camera start, leaving the framebus alone", async () => {
    setPlatform("win32");
    rpcResults["output.vcam.start"] = new Error("vcam_start_failed");
    const client = new MeetingHelperClient("\\\\.\\pipe\\x", 2000, { platform: "win32" });

    await expect(client.virtualCameraStart()).rejects.toThrow("vcam_start_failed");

    expect(calledMethods()).toContain("output.vcam.raw.stop");
    expect(calledMethods()).not.toContain("output.framebus.start");
    expect(calledMethods()).not.toContain("output.framebus.stop");
  });

  it("stop disarms only the raw stream and keeps a running framebus untouched", async () => {
    setPlatform("darwin");
    rpcResults["output.framebus.status"] = { enabled: true, running: true, name: "bfy" };
    const client = new MeetingHelperClient("/tmp/x.sock", 2000, { platform: "darwin" });

    const result = await client.virtualCameraStop();

    expect(calledMethods()).toContain("output.vcam.raw.stop");
    expect(calledMethods()).not.toContain("output.framebus.stop");
    expect(result).toMatchObject({ framebus_output: { running: true } });
    expect(typeof result.message).toBe("string");
  });
});
