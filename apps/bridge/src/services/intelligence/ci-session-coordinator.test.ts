import { setBridgeContext } from "../bridge-context.js";
import type { CiRequestMessageT, CiResultMessageT } from "../relay-client.js";
import { CiSessionCoordinator } from "./ci-session-coordinator.js";
import type { CiUploadTaskT } from "./upload-queue-store.js";
import type { UsageEventT } from "./intelligence-types.js";

const CALL_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

type FakeTransportT = {
  isConnected: jest.Mock;
  sendCiRequest: jest.Mock;
  requests: CiRequestMessageT[];
};

function createFakeTransport(
  respond: (request: CiRequestMessageT) => CiResultMessageT | Error,
): FakeTransportT {
  const requests: CiRequestMessageT[] = [];
  const sendCiRequest = jest.fn(async (request: CiRequestMessageT) => {
    requests.push(request);
    const result = respond(request);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });
  return { isConnected: jest.fn(() => true), sendCiRequest, requests };
}

const okResult = (
  request: CiRequestMessageT,
  extra: Partial<CiResultMessageT> = {},
): CiResultMessageT => ({
  type: "ci_result",
  op: request.type,
  callId: request.callId,
  success: true,
  ...(request.type === "ci_call_start" ? { accepted: true } : {}),
  ...(request.type === "ci_upload_request"
    ? { uploadUrl: "https://example.supabase.co/storage/v1/upload?token=x" }
    : {}),
  ...extra,
});

function createMemoryQueueStore(initial: CiUploadTaskT[] = []) {
  let stored: CiUploadTaskT[] = initial;
  return {
    load: jest.fn(async () => stored.map((task) => ({ ...task }))),
    save: jest.fn(async (tasks: CiUploadTaskT[]) => {
      stored = tasks.map((task) => ({ ...task }));
    }),
    get stored() {
      return stored;
    },
  };
}

const sampleEvents: UsageEventT[] = [
  {
    v: 1,
    type: "call_started",
    at: 1000,
    call_id: CALL_ID,
  },
  {
    v: 1,
    type: "graphic_shown",
    at: 1500,
    source: "meeting-front",
    layer_id: "layer-1",
    category: "names",
  },
  {
    v: 1,
    type: "call_ended",
    at: 5000,
    call_id: CALL_ID,
    reason: "clients_gone",
  },
  {
    v: 1,
    type: "call_started",
    at: 900,
    call_id: "ffffffff-1111-2222-3333-444444444444",
  },
];

function createCoordinator(options: {
  transport: FakeTransportT;
  queueStore?: ReturnType<typeof createMemoryQueueStore>;
  upload?: jest.Mock;
  now?: () => number;
}) {
  const upload = options.upload ?? jest.fn(async () => undefined);
  const queueStore = options.queueStore ?? createMemoryQueueStore();
  const coordinator = new CiSessionCoordinator({
    queueStore,
    recorder: {
      readEventsInRange: jest.fn(async () => sampleEvents),
    },
    upload: upload as never,
    now: options.now ?? (() => 10_000),
    startupDrainDelayMs: 0,
    retryBaseMs: 1000,
  });
  coordinator.attachTransport(options.transport);
  return { coordinator, upload, queueStore };
}

async function flushTimers(): Promise<void> {
  // Drain timers are real (0 ms); yield the event loop a few times.
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  setBridgeContext({
    userDataDir: "/tmp/bridge-data",
    logPath: "/tmp/bridge.log",
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  });
});

describe("CiSessionCoordinator", () => {
  it("runs the full broker sequence for a finished call", async () => {
    const transport = createFakeTransport((request) => okResult(request));
    const { coordinator, upload } = createCoordinator({ transport });
    await coordinator.initialize();

    coordinator.noteCallStarted(CALL_ID, 1000);
    coordinator.noteCallEnded(CALL_ID, 5000, "clients_gone");
    await flushTimers();

    expect(transport.requests.map((request) => request.type)).toEqual([
      "ci_call_start",
      "ci_call_end",
      "ci_upload_request",
      "ci_upload_complete",
    ]);
    expect(transport.requests[0]).toMatchObject({
      callId: CALL_ID,
      startedAt: 1000,
    });
    expect(transport.requests[1]).toMatchObject({
      endedAt: 5000,
      reason: "clients_gone",
    });
    expect(upload).toHaveBeenCalledTimes(1);
    const body = (upload.mock.calls[0][1] as Buffer).toString("utf8");
    const lines = body.trim().split("\n").map((line) => JSON.parse(line));
    // Foreign call markers are filtered out, graphics events kept.
    expect(lines).toHaveLength(3);
    expect(
      lines.filter((line) => line.call_id === "ffffffff-1111-2222-3333-444444444444"),
    ).toHaveLength(0);
    expect(coordinator.getPendingTaskCount()).toBe(0);
  });

  it("drops the task when the org gate rejects the call", async () => {
    const transport = createFakeTransport((request) =>
      request.type === "ci_call_start"
        ? okResult(request, { accepted: false, reason: "feature_disabled" })
        : okResult(request),
    );
    const { coordinator, upload } = createCoordinator({ transport });
    await coordinator.initialize();

    coordinator.noteCallEnded(CALL_ID, 5000, "ended");
    await flushTimers();

    expect(transport.requests.map((request) => request.type)).toEqual([
      "ci_call_start",
    ]);
    expect(upload).not.toHaveBeenCalled();
    expect(coordinator.getPendingTaskCount()).toBe(0);
  });

  it("keeps the task with backoff when the broker fails", async () => {
    const transport = createFakeTransport(() => new Error("relay down"));
    const queueStore = createMemoryQueueStore();
    const { coordinator } = createCoordinator({ transport, queueStore });
    await coordinator.initialize();

    coordinator.noteCallEnded(CALL_ID, 5000, "ended");
    await flushTimers();

    expect(coordinator.getPendingTaskCount()).toBe(1);
    expect(queueStore.stored[0]).toMatchObject({
      callId: CALL_ID,
      attempts: 1,
    });
    expect(queueStore.stored[0].nextAttemptAt).toBeGreaterThan(10_000);
  });

  it("drains persisted tasks from a previous run on startup", async () => {
    const transport = createFakeTransport((request) => okResult(request));
    const queueStore = createMemoryQueueStore([
      {
        callId: CALL_ID,
        startedAt: 1000,
        endedAt: 5000,
        endReason: "engine_stopped",
        attempts: 2,
        nextAttemptAt: 0,
      },
    ]);
    const { coordinator } = createCoordinator({ transport, queueStore });
    await coordinator.initialize();
    await flushTimers();

    expect(transport.requests.map((request) => request.type)).toEqual([
      "ci_call_start",
      "ci_call_end",
      "ci_upload_request",
      "ci_upload_complete",
    ]);
    expect(coordinator.getPendingTaskCount()).toBe(0);
  });

  it("waits while the relay is disconnected", async () => {
    const transport = createFakeTransport((request) => okResult(request));
    transport.isConnected.mockReturnValue(false);
    const { coordinator } = createCoordinator({ transport });
    await coordinator.initialize();

    coordinator.noteCallEnded(CALL_ID, 5000, "ended");
    await flushTimers();

    expect(transport.sendCiRequest).not.toHaveBeenCalled();
    expect(coordinator.getPendingTaskCount()).toBe(1);
  });
});
