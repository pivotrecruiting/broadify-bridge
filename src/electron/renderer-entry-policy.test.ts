import path from "path";
import {
  ALLOWED_RENDERER_ENTRY_BASENAMES,
  resolveAllowedRendererEntry,
} from "./renderer-entry-policy.js";

const RESOURCES_ROOT = "/Applications/Bridge.app/Contents/Resources";
const APP_ROOT = "/Applications/Bridge.app/Contents/Resources/app.asar";
const ROOTS = [RESOURCES_ROOT, APP_ROOT];

const identityRealpath = (p: string) => path.resolve(p);

describe("renderer-entry-policy", () => {
  it("exports the allowlisted basenames", () => {
    expect(ALLOWED_RENDERER_ENTRY_BASENAMES).toEqual([
      "electron-renderer-entry.js",
      "display-output-entry.js",
    ]);
  });

  it("accepts an allowlisted entry inside the first root", () => {
    const entry = path.join(
      RESOURCES_ROOT,
      "bridge/dist/services/graphics/renderer/electron-renderer-entry.js",
    );
    const result = resolveAllowedRendererEntry({
      entry,
      allowedRoots: ROOTS,
      realpath: identityRealpath,
      isFile: () => true,
    });
    expect(result).toEqual({ ok: true, path: entry });
  });

  it("accepts an allowlisted entry inside the second root", () => {
    const entry = path.join(
      APP_ROOT,
      "apps/bridge/dist/services/graphics/display/display-output-entry.js",
    );
    const result = resolveAllowedRendererEntry({
      entry,
      allowedRoots: ROOTS,
      realpath: identityRealpath,
      isFile: () => true,
    });
    expect(result).toEqual({ ok: true, path: entry });
  });

  it("rejects ../ traversal that leaves the allowed roots", () => {
    const entry = path.join(
      RESOURCES_ROOT,
      "../../../../tmp/evil/electron-renderer-entry.js",
    );
    const result = resolveAllowedRendererEntry({
      entry,
      allowedRoots: ROOTS,
      realpath: identityRealpath,
      isFile: () => true,
    });
    expect(result).toEqual({ ok: false, reason: "outside_allowed_roots" });
  });

  it("rejects a symlink inside the root that resolves outside of it", () => {
    const entry = path.join(RESOURCES_ROOT, "bridge/electron-renderer-entry.js");
    const result = resolveAllowedRendererEntry({
      entry,
      allowedRoots: ROOTS,
      realpath: (p) => (p === entry ? "/tmp/evil.js" : path.resolve(p)),
      isFile: () => true,
    });
    expect(result).toEqual({ ok: false, reason: "outside_allowed_roots" });
  });

  it("rejects a file inside the root with a non-allowlisted basename", () => {
    const entry = path.join(RESOURCES_ROOT, "bridge/dist/evil.js");
    const result = resolveAllowedRendererEntry({
      entry,
      allowedRoots: ROOTS,
      realpath: identityRealpath,
      isFile: () => true,
    });
    expect(result).toEqual({ ok: false, reason: "disallowed_basename" });
  });

  it("rejects the root directory itself even when it carries an allowlisted name", () => {
    const root = "/opt/electron-renderer-entry.js";
    const result = resolveAllowedRendererEntry({
      entry: root,
      allowedRoots: [root],
      realpath: identityRealpath,
      isFile: () => true,
    });
    expect(result).toEqual({ ok: false, reason: "outside_allowed_roots" });
  });

  it("rejects an entry that is not a regular file", () => {
    const entry = path.join(RESOURCES_ROOT, "bridge/electron-renderer-entry.js");
    const result = resolveAllowedRendererEntry({
      entry,
      allowedRoots: ROOTS,
      realpath: identityRealpath,
      isFile: () => false,
    });
    expect(result).toEqual({ ok: false, reason: "not_a_file" });
  });

  it("reports unresolvable when realpath of the entry throws", () => {
    const entry = path.join(RESOURCES_ROOT, "bridge/electron-renderer-entry.js");
    const result = resolveAllowedRendererEntry({
      entry,
      allowedRoots: ROOTS,
      realpath: () => {
        throw new Error("ENOENT");
      },
      isFile: () => true,
    });
    expect(result).toEqual({ ok: false, reason: "unresolvable" });
  });

  it("reports unresolvable when isFile throws", () => {
    const entry = path.join(RESOURCES_ROOT, "bridge/electron-renderer-entry.js");
    const result = resolveAllowedRendererEntry({
      entry,
      allowedRoots: ROOTS,
      realpath: identityRealpath,
      isFile: () => {
        throw new Error("EACCES");
      },
    });
    expect(result).toEqual({ ok: false, reason: "unresolvable" });
  });

  it("rejects when no allowed roots are configured", () => {
    const result = resolveAllowedRendererEntry({
      entry: "/anywhere/electron-renderer-entry.js",
      allowedRoots: [],
      realpath: identityRealpath,
      isFile: () => true,
    });
    expect(result).toEqual({ ok: false, reason: "outside_allowed_roots" });
  });

  it("uses the real filesystem by default and rejects a missing file", () => {
    const result = resolveAllowedRendererEntry({
      entry: "/definitely/not/here/electron-renderer-entry.js",
      allowedRoots: ["/definitely"],
    });
    expect(result.ok).toBe(false);
  });
});
