import type { EngineConnectConfig } from "./engine-adapter-interface.js";
import type { EngineReconnectInfoT, EngineStatusT } from "../engine-types.js";
import {
  EngineConnectionSupervisor,
  RECONNECT_BASE_DELAY_MS,
  SELF_HEAL_GRACE_MS,
  STARTUP_MAX_ATTEMPTS,
} from "./engine-connection-supervisor.js";
import { ReconnectScheduler } from "../shared/backoff.js";

const config: EngineConnectConfig = {
  type: "atem",
  transport: "usb",
  ip: "",
  port: 0,
};

const createSupervisor = () => {
  let status: EngineStatusT = "disconnected";
  const events: string[] = [];
  const reconnectInfos: Array<EngineReconnectInfoT | null> = [];
  const driver = {
    open: jest.fn(async () => {
      events.push("open");
      status = "connected";
    }),
    close: jest.fn(async () => {
      events.push("close");
      status = "disconnected";
    }),
  };
  const supervisor = new EngineConnectionSupervisor({
    driver,
    getStatus: () => status,
    onReconnectStateChange: (info) => reconnectInfos.push(info),
    createScheduler: (kind) =>
      new ReconnectScheduler({
        baseMs: kind === "startup" ? 1000 : RECONNECT_BASE_DELAY_MS,
        maxMs: 30_000,
        jitterRatio: 0,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
        now: () => Date.now(),
        random: () => 0.5,
      }),
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    now: () => Date.now(),
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
  });
  return { supervisor, driver, events, reconnectInfos, setStatus: (next: EngineStatusT) => { status = next; } };
};

describe("EngineConnectionSupervisor", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("reconnects after an unsolicited drop with exponential backoff", async () => {
    const { supervisor, driver, events } = createSupervisor();
    await supervisor.connect(config, "manual");
    driver.open
      .mockImplementationOnce(async () => {
        events.push("open");
        throw new Error("first miss");
      })
      .mockImplementationOnce(async () => {
        events.push("open");
        throw new Error("second miss");
      })
      .mockImplementationOnce(async () => {
        events.push("open");
        throw new Error("third miss");
      })
      .mockImplementationOnce(async () => {
        events.push("open");
      });

    supervisor.handleSessionStatus("connected", "disconnected");

    expect(events).toEqual(["open", "close"]);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1001);
    expect(events).toEqual(["open", "close", "open"]);
    await jest.advanceTimersByTimeAsync(2000);
    expect(events).toEqual(["open", "close", "open", "open"]);
    await jest.advanceTimersByTimeAsync(4000);
    expect(events).toEqual(["open", "close", "open", "open", "open"]);
    await jest.advanceTimersByTimeAsync(8000);
    expect(events).toEqual(["open", "close", "open", "open", "open", "open"]);
  });

  it("stays passive during self-heal and takes over after the grace period", async () => {
    const { supervisor, driver, events, setStatus } = createSupervisor();
    await supervisor.connect(config, "manual");

    supervisor.handleSessionStatus("connected", "connecting");
    setStatus("connecting");
    await jest.advanceTimersByTimeAsync(SELF_HEAL_GRACE_MS - 1);
    expect(driver.close).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(events).toEqual(["open", "close"]);
  });

  it("manual disconnect cancels a pending retry", async () => {
    const { supervisor, driver } = createSupervisor();
    await supervisor.connect(config, "manual");
    driver.open.mockRejectedValueOnce(new Error("miss"));
    supervisor.handleSessionStatus("connected", "disconnected");

    await supervisor.disconnect();
    await jest.advanceTimersByTimeAsync(1000);

    expect(driver.open).toHaveBeenCalledTimes(1);
  });

  it("beginShutdown suppresses reconnects on later drops", async () => {
    const { supervisor, driver } = createSupervisor();
    await supervisor.connect(config, "manual");
    supervisor.beginShutdown();

    supervisor.handleSessionStatus("connected", "disconnected");
    await jest.advanceTimersByTimeAsync(1000);

    expect(driver.open).toHaveBeenCalledTimes(1);
  });

  it("startup gives up after STARTUP_MAX_ATTEMPTS and closes silently", async () => {
    const { supervisor, driver } = createSupervisor();
    driver.open.mockRejectedValue(new Error("no switcher"));

    await supervisor.connect(config, "startup");
    for (let i = 0; i < STARTUP_MAX_ATTEMPTS; i += 1) {
      await jest.advanceTimersByTimeAsync(1000 * 2 ** i);
    }

    expect(driver.open).toHaveBeenCalledTimes(STARTUP_MAX_ATTEMPTS);
    expect(driver.close).toHaveBeenCalledTimes(1);
  });

  it("startup failure opens exactly STARTUP_MAX_ATTEMPTS times", async () => {
    const { supervisor, driver } = createSupervisor();
    driver.open.mockRejectedValue(new Error("no switcher"));

    await supervisor.connect(config, "startup");
    await jest.advanceTimersByTimeAsync(60_000);

    expect(driver.open).toHaveBeenCalledTimes(STARTUP_MAX_ATTEMPTS);
  });

  it("a manual connect during an in-flight startup attempt invalidates it", async () => {
    const { supervisor, driver, reconnectInfos } = createSupervisor();
    let rejectStartup: (error: Error) => void;
    driver.open.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectStartup = reject;
        }),
    );
    const startupConnect = supervisor.connect(config, "startup");
    await Promise.resolve();

    await supervisor.connect({ type: "atem", ip: "10.0.0.10", port: 9910 }, "manual");
    rejectStartup!(new Error("stale startup failure"));
    await startupConnect;
    await jest.advanceTimersByTimeAsync(60_000);

    expect(driver.open).toHaveBeenCalledTimes(2);
    expect(reconnectInfos.at(-1)).toBeNull();
  });

  it("resets backoff after a successful reconnect", async () => {
    const { supervisor, driver, reconnectInfos } = createSupervisor();
    await supervisor.connect(config, "manual");
    driver.open.mockRejectedValueOnce(new Error("miss")).mockResolvedValueOnce(undefined);

    supervisor.handleSessionStatus("connected", "disconnected");
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(2000);

    expect(reconnectInfos.at(-1)).toBeNull();
  });

  it("ignores disconnected→disconnected", async () => {
    const { supervisor, driver } = createSupervisor();
    await supervisor.connect(config, "manual");

    supervisor.handleSessionStatus("disconnected", "disconnected");
    await jest.advanceTimersByTimeAsync(1000);

    expect(driver.close).not.toHaveBeenCalled();
    expect(driver.open).toHaveBeenCalledTimes(1);
  });
});
