import { isDevelopmentMode } from "../dev-mode.js";
import { selectOutputAdapter } from "./graphics-output-adapter-factory.js";

jest.mock("../dev-mode.js", () => ({
  isDevelopmentMode: jest.fn().mockReturnValue(false),
}));

const mockFindCachedDevicePortById = jest.fn();

const stubInstance = { _kind: "stub" as const };
const keyFillInstance = { _kind: "key_fill_sdi" as const };
const videoSdiInstance = { _kind: "video_sdi" as const };
const displayInstance = { _kind: "display" as const };

jest.mock("./graphics-device-port-resolver.js", () => ({
  findCachedDevicePortById: (id: string) => mockFindCachedDevicePortById(id),
}));

jest.mock("./output-adapters/stub-output-adapter.js", () => ({
  StubOutputAdapter: jest.fn().mockImplementation(() => stubInstance),
}));
jest.mock("./output-adapters/decklink-key-fill-output-adapter.js", () => ({
  DecklinkKeyFillOutputAdapter: jest.fn().mockImplementation(() => keyFillInstance),
}));
jest.mock("./output-adapters/decklink-video-output-adapter.js", () => ({
  DecklinkVideoOutputAdapter: jest.fn().mockImplementation(() => videoSdiInstance),
}));
jest.mock("./output-adapters/display-output-adapter.js", () => ({
  DisplayVideoOutputAdapter: jest.fn().mockImplementation(() => displayInstance),
}));

describe("selectOutputAdapter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isDevelopmentMode as jest.Mock).mockReturnValue(false);
  });

  it("returns StubOutputAdapter in development mode", async () => {
    (isDevelopmentMode as jest.Mock).mockReturnValue(true);

    const adapter = await selectOutputAdapter({
      version: 1,
      outputKey: "video_sdi",
      targets: { output1Id: "port-1" },
      format: { width: 1920, height: 1080, fps: 50 },
      range: "legal",
      colorspace: "auto",
    });

    expect(adapter).toBe(stubInstance);
    expect(mockFindCachedDevicePortById).not.toHaveBeenCalled();
  });

  it("returns DecklinkKeyFillOutputAdapter for key_fill_sdi", async () => {
    const adapter = await selectOutputAdapter({
      version: 1,
      outputKey: "key_fill_sdi",
      targets: { output1Id: "fill-1", output2Id: "key-1" },
      format: { width: 1920, height: 1080, fps: 50 },
      range: "legal",
      colorspace: "auto",
    });

    expect(adapter).toBe(keyFillInstance);
  });

  it("returns DecklinkVideoOutputAdapter for video_sdi", async () => {
    const adapter = await selectOutputAdapter({
      version: 1,
      outputKey: "video_sdi",
      targets: { output1Id: "port-1" },
      format: { width: 1920, height: 1080, fps: 50 },
      range: "legal",
      colorspace: "auto",
    });

    expect(adapter).toBe(videoSdiInstance);
  });

  it("returns DisplayVideoOutputAdapter for video_hdmi when target is display", async () => {
    mockFindCachedDevicePortById.mockResolvedValue({
      device: { id: "disp-1", type: "display" },
      port: { id: "out-1", type: "hdmi" },
    });

    const adapter = await selectOutputAdapter({
      version: 1,
      outputKey: "video_hdmi",
      targets: { output1Id: "out-1" },
      format: { width: 1920, height: 1080, fps: 50 },
      range: "legal",
      colorspace: "auto",
    });

    expect(adapter).toBe(displayInstance);
    expect(mockFindCachedDevicePortById).toHaveBeenCalledWith("out-1");
  });

  it("returns DecklinkVideoOutputAdapter for video_hdmi when target is not display", async () => {
    mockFindCachedDevicePortById.mockResolvedValue({
      device: { id: "deck-1", type: "decklink" },
      port: { id: "out-1", type: "hdmi" },
    });

    const adapter = await selectOutputAdapter({
      version: 1,
      outputKey: "video_hdmi",
      targets: { output1Id: "out-1" },
      format: { width: 1920, height: 1080, fps: 50 },
      range: "legal",
      colorspace: "auto",
    });

    expect(adapter).toBe(videoSdiInstance);
  });

  it("returns DecklinkVideoOutputAdapter for video_hdmi when output1Id is missing", async () => {
    const adapter = await selectOutputAdapter({
      version: 1,
      outputKey: "video_hdmi",
      targets: {},
      format: { width: 1920, height: 1080, fps: 50 },
      range: "legal",
      colorspace: "auto",
    });

    expect(adapter).toBe(videoSdiInstance);
    expect(mockFindCachedDevicePortById).not.toHaveBeenCalled();
  });

  it("returns DecklinkVideoOutputAdapter for video_hdmi when port lookup returns null", async () => {
    mockFindCachedDevicePortById.mockResolvedValue(null);

    const adapter = await selectOutputAdapter({
      version: 1,
      outputKey: "video_hdmi",
      targets: { output1Id: "unknown" },
      format: { width: 1920, height: 1080, fps: 50 },
      range: "legal",
      colorspace: "auto",
    });

    expect(adapter).toBe(videoSdiInstance);
  });

  it("returns StubOutputAdapter for stub outputKey", async () => {
    const adapter = await selectOutputAdapter({
      version: 1,
      outputKey: "stub",
      targets: {},
      format: { width: 1920, height: 1080, fps: 50 },
      range: "legal",
      colorspace: "auto",
    });

    expect(adapter).toBe(stubInstance);
  });
});
