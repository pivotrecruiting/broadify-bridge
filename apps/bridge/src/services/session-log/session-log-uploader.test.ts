import { promises as fs } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { SessionLogUploader } from "./session-log-uploader.js";

describe("SessionLogUploader", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const identity = { bridgeId: "11111111-1111-4111-8111-111111111111", keyId: "bridge-1", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };

  async function makeDir() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-log-"));
    const lines = [
      JSON.stringify({ schema_version: "1.0.0", session_id: "sess-0001-abcd", bridge_id: identity.bridgeId, started_at_ms: 1000, switcher: "atem" }),
      JSON.stringify({ at_ms: 1000, type: "recording_started", source: "atem", origin: "live" }),
      JSON.stringify({ at_ms: 2000, type: "program_changed", source: "atem", origin: "live", me: 0, input_id: "2" }),
      JSON.stringify({ at_ms: 3000, type: "recording_stopped", source: "atem", origin: "live" }),
    ];
    await fs.writeFile(path.join(dir, "sess-0001-abcd.jsonl"), lines.join("\n") + "\n");
    return dir;
  }

  test("uploads with signed requests, PUTs the file, registers and writes a marker", async () => {
    const dir = await makeDir();
    const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string | Buffer }> = [];
    const fetchFn = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Buffer }) => {
      calls.push({ url, ...init });
      const reply = (payload: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
      if (url.endsWith("/upload-url")) {
        return reply({ success: true, data: { path: "orgs/o/sessions/b/sess-0001-abcd.jsonl", token: "t", url: "https://storage.example/put" } });
      }
      if (url === "https://storage.example/put") {
        return reply({ Key: "x" });
      }
      return reply({ success: true, data: { id: "row-1" } });
    };
    const uploader = new SessionLogUploader({ apiBaseUrl: "https://app.example/", dir, getIdentity: async () => identity, fetchFn });
    await uploader.scan();
    expect(calls.map((c) => c.url)).toEqual(["https://app.example/api/postpro/bridge/sessions/upload-url", "https://storage.example/put", "https://app.example/api/postpro/bridge/sessions/complete"]);
    expect(calls[0].headers?.["x-postpro-bridge-assertion"]).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(JSON.parse(String(calls[2].body))).toEqual({ session_id: "sess-0001-abcd", switcher: "atem", started_at_ms: 1000, ended_at_ms: 3000, event_count: 3, storage_path: "orgs/o/sessions/b/sess-0001-abcd.jsonl" });
    expect(JSON.parse(await fs.readFile(path.join(dir, "sess-0001-abcd.uploaded.json"), "utf8"))).toMatchObject({ event_count: 3 });
    await uploader.scan();
    expect(calls).toHaveLength(3);                     // marker prevents re-upload
  });

  test("scan skips the session that is currently open", async () => {
    const dir = await makeDir();
    const fetchFn = jest.fn();
    const uploader = new SessionLogUploader({ apiBaseUrl: "https://app.example", dir, getIdentity: async () => identity, fetchFn, isSessionOpen: (id) => id === "sess-0001-abcd" });
    await uploader.scan();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("failures are logged, bounded and retried on the next scan", async () => {
    const dir = await makeDir();
    let attempts = 0;
    const fetchFn = async () => {
      attempts += 1;
      return { ok: false, status: 503, text: async () => "down" };
    };
    const warn = jest.fn();
    const uploader = new SessionLogUploader({ apiBaseUrl: "https://app.example", dir, getIdentity: async () => identity, fetchFn, logger: { info: jest.fn(), warn } });
    await uploader.enqueue("sess-0001-abcd");
    await uploader.scan();
    expect(attempts).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    await expect(fs.access(path.join(dir, "sess-0001-abcd.uploaded.json"))).rejects.toBeDefined();
  });
});
