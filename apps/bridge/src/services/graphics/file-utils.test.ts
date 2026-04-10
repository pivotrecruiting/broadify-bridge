import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureDir, atomicWriteJson } from "./file-utils.js";

describe("file-utils", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `file-utils-test-${Date.now()}`);
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("ensureDir", () => {
    it("creates directory", async () => {
      const dir = path.join(testDir, "nested", "path");
      await ensureDir(dir);
      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("does not fail when directory already exists", async () => {
      await fs.mkdir(testDir, { recursive: true });
      await ensureDir(testDir);
      const stat = await fs.stat(testDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe("atomicWriteJson", () => {
    it("writes JSON to file atomically", async () => {
      const filePath = path.join(testDir, "data.json");
      const data = { foo: "bar", count: 42 };
      await atomicWriteJson(filePath, data);
      const raw = await fs.readFile(filePath, "utf-8");
      expect(JSON.parse(raw)).toEqual(data);
    });

    it("creates parent directory if missing", async () => {
      const filePath = path.join(testDir, "nested", "data.json");
      await atomicWriteJson(filePath, { x: 1 });
      const stat = await fs.stat(path.dirname(filePath));
      expect(stat.isDirectory()).toBe(true);
    });

    it("formats JSON with indentation", async () => {
      const filePath = path.join(testDir, "data.json");
      await atomicWriteJson(filePath, { a: 1 });
      const raw = await fs.readFile(filePath, "utf-8");
      expect(raw).toContain("\n");
      expect(JSON.parse(raw)).toEqual({ a: 1 });
    });

    it("does not leave .tmp file after write", async () => {
      const filePath = path.join(testDir, "data.json");
      await atomicWriteJson(filePath, {});
      const tmpPath = `${filePath}.tmp`;
      await expect(fs.access(tmpPath)).rejects.toThrow();
    });
  });
});
