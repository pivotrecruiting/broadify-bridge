import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setBridgeContext, type BridgeContextT } from "../bridge-context.js";
import {
  RECORDING_UPLOAD_STATUS_EVENT,
  configureRecordingUpload,
  initializeRecordingUpload,
  isRecordingUploadAvailable,
  noteMeetingStatusForRecordingUpload,
  resetRecordingUploadForTests,
  shutdownRecordingUpload,
} from "./recording-upload-service.js";

const BRIDGE_ID = "11111111-1111-4111-8111-111111111111";

describe("recording upload service", () => {
  let userDataDir: string;
  const publishBridgeEvent = jest.fn();
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const fetchSpy = jest.spyOn(globalThis, "fetch");

  const setContext = (overrides: Partial<BridgeContextT> = {}) =>
    setBridgeContext({ userDataDir, logger, logPath: path.join(userDataDir, "log.txt"), publishBridgeEvent, ...overrides });

  const exists = (target: string) =>
    fs.access(target).then(
      () => true,
      () => false,
    );

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-recording-upload-service-"));
    publishBridgeEvent.mockClear();
    fetchSpy.mockReset().mockRejectedValue(new Error("no network in tests"));
  });

  afterEach(async () => {
    await resetRecordingUploadForTests();
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  afterAll(() => {
    fetchSpy.mockRestore();
  });

  it.each([
    ["no platform address", { bridgeId: BRIDGE_ID }],
    ["no bridge id (relay not set up)", { platformApiUrl: "https://app.example" }],
    // The session-log switch alone is not the platform address of the upload.
    ["neither", {}],
  ])("is unavailable and completely inert with %s", async (_name, overrides) => {
    setContext(overrides);
    expect(isRecordingUploadAvailable()).toBe(false);

    await initializeRecordingUpload();
    noteMeetingStatusForRecordingUpload({ engine: {}, recording: { active: true, file_path: "/tmp/a.mp4.part", codec: "h264" }, program_format: { width: 1920, height: 1080, fps: 30 } });
    expect(await configureRecordingUpload(true)).toEqual({ enabled: false, available: false, tasks: [], last_skipped: null });
    await shutdownRecordingUpload();

    expect(await exists(path.join(userDataDir, "recording-upload"))).toBe(false);
    expect(publishBridgeEvent).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is available with a platform address and a bridge id; the hint starts off", async () => {
    setContext({ bridgeId: BRIDGE_ID, platformApiUrl: "https://app.example", platformApiUrlGuarded: true });
    expect(isRecordingUploadAvailable()).toBe(true);

    await initializeRecordingUpload();
    expect(await configureRecordingUpload(false)).toEqual({ enabled: false, available: true, tasks: [], last_skipped: null });
    expect(publishBridgeEvent).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    // Nothing recorded, nothing pushed: the startup leaves no file behind.
    expect(await exists(path.join(userDataDir, "recording-upload"))).toBe(false);
  });

  it("stores the pushed hint across a bridge restart and publishes the snapshot as recording_upload_status", async () => {
    setContext({ bridgeId: BRIDGE_ID, platformApiUrl: "https://app.example", platformApiUrlGuarded: true });
    await initializeRecordingUpload();
    expect(await configureRecordingUpload(true)).toMatchObject({ enabled: true, available: true });

    expect(publishBridgeEvent).toHaveBeenCalledTimes(1);
    expect(publishBridgeEvent).toHaveBeenCalledWith({
      event: RECORDING_UPLOAD_STATUS_EVENT,
      data: { at: expect.any(Number), upload: { enabled: true, available: true, tasks: [], last_skipped: null } },
    });
    expect(RECORDING_UPLOAD_STATUS_EVENT).toBe("recording_upload_status");

    await resetRecordingUploadForTests();
    await initializeRecordingUpload();
    expect(await configureRecordingUpload(true)).toMatchObject({ enabled: true });
    // Unchanged hint: no second event.
    expect(publishBridgeEvent).toHaveBeenCalledTimes(1);
  });

  it("publishes nothing while the relay is disconnected; the configure result still carries the snapshot", async () => {
    let connected = false;
    setContext({ bridgeId: BRIDGE_ID, platformApiUrl: "https://app.example", platformApiUrlGuarded: true, isRelayConnected: () => connected });
    await initializeRecordingUpload();
    expect(await configureRecordingUpload(true)).toMatchObject({ enabled: true, available: true });
    expect(publishBridgeEvent).not.toHaveBeenCalled();

    connected = true;
    expect(await configureRecordingUpload(false)).toMatchObject({ enabled: false });
    expect(publishBridgeEvent).toHaveBeenCalledTimes(1);
  });

  it("with the hint off a finished recording sends nothing to the platform", async () => {
    setContext({ bridgeId: BRIDGE_ID, platformApiUrl: "http://localhost:3021", platformApiUrlGuarded: false });
    const filePath = path.join(userDataDir, "Broadify-Meeting-1.mp4");
    await fs.writeFile(filePath, "recording");
    await initializeRecordingUpload();

    const status = (active: boolean) => ({
      engine: { program_revision: 1 },
      recording: { active, file_path: active ? `${filePath}.part` : filePath, codec: "h264", last_error: "" },
      program_format: { width: 1920, height: 1080, fps: 30 },
    });
    noteMeetingStatusForRecordingUpload(status(true));
    noteMeetingStatusForRecordingUpload(status(false));
    await shutdownRecordingUpload();

    expect(fetchSpy).not.toHaveBeenCalled();
    const queue = JSON.parse(await fs.readFile(path.join(userDataDir, "recording-upload", "queue.json"), "utf8"));
    expect(queue).toEqual({ tasks: [] });
  });
});
