/**
 * Tests for FrameBus client logic.
 * Tests framebus-client-internal.ts (the main framebus-client.ts uses import.meta.url
 * which Jest does not transform).
 */
import path from "node:path";
import {
  resolveFrameBusNativeCandidates,
  findNativeAddonPath,
  mapFrameBusError,
  wrapModule,
} from "./framebus-client-internal.js";
import type {
  FrameBusModuleT,
  FrameBusWriterT,
  FrameBusReaderT,
  FrameBusHeaderT,
} from "./framebus-client.js";
import { InvalidHeaderError, FrameSizeError, OpenError } from "./framebus-errors.js";

const mockExistsSync = jest.fn<boolean, [string]>();

jest.mock("node:fs", () => ({
  existsSync: (p: string) => mockExistsSync(p),
}));

const FAKE_BRIDGE_ROOT = "/fake/bridge/root/apps/bridge";

const mockHeader: FrameBusHeaderT = {
  magic: 0x46524253,
  version: 1,
  flags: 0,
  headerSize: 64,
  width: 1920,
  height: 1080,
  fps: 30,
  pixelFormat: 1,
  frameSize: 1920 * 1080 * 4,
  slotCount: 2,
  slotStride: 1920 * 1080 * 4,
  seq: BigInt(0),
  lastWriteNs: BigInt(0),
};

function createMockModule(overrides?: Partial<FrameBusModuleT>): FrameBusModuleT {
  const writer: FrameBusWriterT = {
    name: "test-writer",
    size: 1920 * 1080 * 4,
    header: mockHeader,
    writeFrame: jest.fn(),
    close: jest.fn(),
  };
  const reader: FrameBusReaderT = {
    name: "test-reader",
    header: mockHeader,
    readLatest: jest.fn().mockReturnValue(null),
    close: jest.fn(),
  };
  return {
    createWriter: jest.fn().mockReturnValue(writer),
    openReader: jest.fn().mockReturnValue(reader),
    ...overrides,
  };
}

describe("framebus-client (internal)", () => {
  const originalEnv = process.env;
  const originalResourcesPath = process.resourcesPath;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.BRIDGE_FRAMEBUS_NATIVE_PATH;
    process.resourcesPath = originalResourcesPath;
  });

  afterEach(() => {
    process.env = originalEnv;
    process.resourcesPath = originalResourcesPath;
  });

  describe("error classes", () => {
    it("InvalidHeaderError has correct name", () => {
      const err = new InvalidHeaderError("bad header");
      expect(err.name).toBe("InvalidHeaderError");
      expect(err.message).toBe("bad header");
    });

    it("FrameSizeError has correct name", () => {
      const err = new FrameSizeError("size mismatch");
      expect(err.name).toBe("FrameSizeError");
      expect(err.message).toBe("size mismatch");
    });

    it("OpenError has correct name", () => {
      const err = new OpenError("open failed");
      expect(err.name).toBe("OpenError");
      expect(err.message).toBe("open failed");
    });
  });

  describe("resolveFrameBusNativeCandidates", () => {
    it("returns env path first when BRIDGE_FRAMEBUS_NATIVE_PATH is set", () => {
      process.env.BRIDGE_FRAMEBUS_NATIVE_PATH = "/custom/framebus.node";
      const candidates = resolveFrameBusNativeCandidates(FAKE_BRIDGE_ROOT);
      expect(candidates[0]).toBe("/custom/framebus.node");
      expect(candidates).toContain(
        path.join(FAKE_BRIDGE_ROOT, "native", "framebus", "build", "Release", "framebus.node")
      );
      expect(candidates).toContain(
        path.join(FAKE_BRIDGE_ROOT, "native", "framebus", "build", "Debug", "framebus.node")
      );
    });

    it("includes bridge root Release and Debug paths", () => {
      const candidates = resolveFrameBusNativeCandidates(FAKE_BRIDGE_ROOT);
      expect(candidates).toContain(
        path.join(FAKE_BRIDGE_ROOT, "native", "framebus", "build", "Release", "framebus.node")
      );
      expect(candidates).toContain(
        path.join(FAKE_BRIDGE_ROOT, "native", "framebus", "build", "Debug", "framebus.node")
      );
    });

    it("includes resources path when process.resourcesPath is set", () => {
      process.resourcesPath = "/app/Resources";
      const candidates = resolveFrameBusNativeCandidates(FAKE_BRIDGE_ROOT);
      expect(candidates).toContain(
        path.join("/app/Resources", "bridge", "native", "framebus", "build", "Release", "framebus.node")
      );
    });

    it("omits resources path when process.resourcesPath is falsy", () => {
      process.resourcesPath = undefined as unknown as string;
      const candidates = resolveFrameBusNativeCandidates(FAKE_BRIDGE_ROOT);
      const resourcesCandidate = candidates.find((c) => c.includes("resources") || c.includes("Resources"));
      expect(resourcesCandidate).toBeUndefined();
    });
  });

  describe("findNativeAddonPath", () => {
    it("returns null when no candidate exists", () => {
      mockExistsSync.mockReturnValue(false);
      const candidates = ["/a/node", "/b/node"];
      expect(findNativeAddonPath(candidates)).toBeNull();
    });

    it("returns first existing candidate", () => {
      mockExistsSync.mockImplementation((p: string) => p === "/b/node");
      const candidates = ["/a/node", "/b/node", "/c/node"];
      expect(findNativeAddonPath(candidates)).toBe("/b/node");
    });

    it("skips empty candidate strings", () => {
      mockExistsSync.mockReturnValue(false);
      const candidates = ["", "  ", "/valid/node"];
      mockExistsSync.mockImplementation((p: string) => p === "/valid/node");
      expect(findNativeAddonPath(candidates)).toBe("/valid/node");
    });
  });

  describe("mapFrameBusError", () => {
    it("returns InvalidHeaderError for 'Invalid FrameBus header'", () => {
      const err = mapFrameBusError(new Error("Invalid FrameBus header: bad magic"));
      expect(err).toBeInstanceOf(InvalidHeaderError);
      expect(err.message).toContain("bad magic");
    });

    it("returns InvalidHeaderError for 'Invalid header'", () => {
      const err = mapFrameBusError(new Error("Invalid header"));
      expect(err).toBeInstanceOf(InvalidHeaderError);
    });

    it("returns FrameSizeError for 'Frame size mismatch'", () => {
      const err = mapFrameBusError(new Error("Frame size mismatch"));
      expect(err).toBeInstanceOf(FrameSizeError);
    });

    it("returns FrameSizeError for 'size too large'", () => {
      const err = mapFrameBusError(new Error("size too large"));
      expect(err).toBeInstanceOf(FrameSizeError);
    });

    it("returns OpenError for 'openReader' message", () => {
      const err = mapFrameBusError(new Error("openReader failed"));
      expect(err).toBeInstanceOf(OpenError);
    });

    it("returns OpenError for 'createWriter' message", () => {
      const err = mapFrameBusError(new Error("createWriter failed"));
      expect(err).toBeInstanceOf(OpenError);
    });

    it("returns OpenError for 'FrameBus name is required'", () => {
      const err = mapFrameBusError(new Error("FrameBus name is required"));
      expect(err).toBeInstanceOf(OpenError);
    });

    it("returns OpenError for 'not implemented'", () => {
      const err = mapFrameBusError(new Error("not implemented"));
      expect(err).toBeInstanceOf(OpenError);
    });

    it("rethrows generic Error when message does not match", () => {
      const customError = new Error("Unknown native error");
      const err = mapFrameBusError(customError);
      expect(err).toBe(customError);
    });

    it("wraps non-Error throw as Error with string message", () => {
      const err = mapFrameBusError("string error");
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe("string error");
    });
  });

  describe("wrapModule", () => {
    it("maps InvalidHeaderError from createWriter", () => {
      const mockModule = createMockModule({
        createWriter: () => {
          throw new Error("Invalid FrameBus header: bad magic");
        },
      });
      const wrapped = wrapModule(mockModule);
      expect(() =>
        wrapped.createWriter({
          name: "test",
          width: 1920,
          height: 1080,
          fps: 30,
          pixelFormat: 1,
          slotCount: 2,
        })
      ).toThrow(InvalidHeaderError);
    });

    it("maps FrameSizeError from createWriter", () => {
      const mockModule = createMockModule({
        createWriter: () => {
          throw new Error("Frame size mismatch");
        },
      });
      const wrapped = wrapModule(mockModule);
      expect(() =>
        wrapped.createWriter({
          name: "test",
          width: 1920,
          height: 1080,
          fps: 30,
          pixelFormat: 1,
          slotCount: 2,
        })
      ).toThrow(FrameSizeError);
    });

    it("maps OpenError from openReader", () => {
      const mockModule = createMockModule({
        openReader: () => {
          throw new Error("openReader failed: not found");
        },
      });
      const wrapped = wrapModule(mockModule);
      expect(() => wrapped.openReader({ name: "test" })).toThrow(OpenError);
    });

    it("wraps writer writeFrame errors", () => {
      const writer = createMockModule().createWriter({
        name: "test",
        width: 1920,
        height: 1080,
        fps: 30,
        pixelFormat: 1,
        slotCount: 2,
      }) as FrameBusWriterT & { writeFrame: jest.Mock };
      writer.writeFrame = jest.fn().mockImplementation(() => {
        throw new Error("Invalid FrameBus header");
      });
      const mockModule = createMockModule({ createWriter: () => writer });
      const wrapped = wrapModule(mockModule);
      const w = wrapped.createWriter({
        name: "test",
        width: 1920,
        height: 1080,
        fps: 30,
        pixelFormat: 1,
        slotCount: 2,
      });
      expect(() => w.writeFrame(Buffer.alloc(100))).toThrow(InvalidHeaderError);
    });

    it("wraps reader readLatest errors", () => {
      const reader = createMockModule().openReader({ name: "test" }) as FrameBusReaderT & { readLatest: jest.Mock };
      reader.readLatest = jest.fn().mockImplementation(() => {
        throw new Error("Frame size mismatch");
      });
      const mockModule = createMockModule({ openReader: () => reader });
      const wrapped = wrapModule(mockModule);
      const r = wrapped.openReader({ name: "test" });
      expect(() => r.readLatest()).toThrow(FrameSizeError);
    });

    it("writer close passes through without error mapping", () => {
      const mockModule = createMockModule();
      const wrapped = wrapModule(mockModule);
      const w = wrapped.createWriter({
        name: "test",
        width: 1920,
        height: 1080,
        fps: 30,
        pixelFormat: 1,
        slotCount: 2,
      });
      expect(() => w.close()).not.toThrow();
    });

    it("reader close passes through without error mapping", () => {
      const mockModule = createMockModule();
      const wrapped = wrapModule(mockModule);
      const r = wrapped.openReader({ name: "test" });
      expect(() => r.close()).not.toThrow();
    });

    it("createWriter passes options to native and returns wrapped writer", () => {
      const mockModule = createMockModule();
      const wrapped = wrapModule(mockModule);
      const w = wrapped.createWriter({
        name: "my-shm",
        width: 3840,
        height: 2160,
        fps: 60,
        pixelFormat: 2,
        slotCount: 4,
        forceRecreate: true,
      });
      expect(w).toBeDefined();
      expect(w.name).toBe("test-writer");
      expect(w.writeFrame).toBeDefined();
      expect(w.close).toBeDefined();
      expect(mockModule.createWriter).toHaveBeenCalledWith({
        name: "my-shm",
        width: 3840,
        height: 2160,
        fps: 60,
        pixelFormat: 2,
        slotCount: 4,
        forceRecreate: true,
      });
    });

    it("openReader passes options to native and returns wrapped reader", () => {
      const mockModule = createMockModule();
      const wrapped = wrapModule(mockModule);
      const r = wrapped.openReader({ name: "my-shm" });
      expect(r).toBeDefined();
      expect(r.name).toBe("test-reader");
      expect(r.readLatest).toBeDefined();
      expect(r.close).toBeDefined();
      expect(mockModule.openReader).toHaveBeenCalledWith({ name: "my-shm" });
    });
  });
});
