/**
 * Allowlist policy for the `--renderer-entry` argument of the Electron aux
 * (graphics-renderer) mode.
 *
 * The packaged desktop binary dynamically imports the file named by
 * `--renderer-entry`. Without a policy any local process could start the
 * signed app with an arbitrary script and run code inside the app bundle
 * (including its TCC camera/microphone entitlements). This module decides
 * whether a requested entry may be loaded: it must be a real file, carry an
 * allowlisted basename and resolve (after symlinks) inside one of the roots
 * that ship with the app.
 *
 * Pure module: filesystem access is injectable for tests.
 */
import fs from "fs";
import path from "path";

export const ALLOWED_RENDERER_ENTRY_BASENAMES = [
  "electron-renderer-entry.js",
  "display-output-entry.js",
] as const;

export type RendererEntryResolutionT =
  | { ok: true; path: string }
  | {
      ok: false;
      reason:
        | "outside_allowed_roots"
        | "disallowed_basename"
        | "not_a_file"
        | "unresolvable";
    };

export interface ResolveAllowedRendererEntryOptionsT {
  /** Raw entry path as received from argv (untrusted). */
  entry: string;
  /** Directories whose contents may be loaded (e.g. resourcesPath, appPath). */
  allowedRoots: readonly string[];
  /** Symlink-resolving realpath; defaults to fs.realpathSync.native. */
  realpath?: (p: string) => string;
  /** Regular-file check; defaults to fs.statSync(p).isFile(). */
  isFile?: (p: string) => boolean;
}

const defaultRealpath = (p: string): string => fs.realpathSync.native(p);
const defaultIsFile = (p: string): boolean => fs.statSync(p).isFile();

/**
 * Checks whether `candidate` lies strictly inside `root` (never equal to it).
 */
function isInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Accepts an entry only if it is a real file, has an allowlisted basename and
 * resolves (after symlinks) inside one of the allowed roots.
 *
 * Any error thrown while resolving or inspecting the entry yields
 * `unresolvable`; the caller must treat every `ok: false` result as a hard
 * rejection and must not echo the untrusted path.
 */
export function resolveAllowedRendererEntry(
  options: ResolveAllowedRendererEntryOptionsT,
): RendererEntryResolutionT {
  const realpath = options.realpath ?? defaultRealpath;
  const isFile = options.isFile ?? defaultIsFile;

  let resolvedEntry: string;
  try {
    if (!isFile(options.entry)) {
      return { ok: false, reason: "not_a_file" };
    }
    resolvedEntry = realpath(options.entry);
  } catch {
    return { ok: false, reason: "unresolvable" };
  }

  let insideAllowedRoot = false;
  for (const root of options.allowedRoots) {
    if (!root) {
      continue;
    }
    let resolvedRoot: string;
    try {
      resolvedRoot = realpath(root);
    } catch {
      // A root that cannot be resolved (e.g. not present in this environment)
      // is compared as given. The entry itself is already symlink-resolved,
      // so this can only make the check stricter, never looser.
      resolvedRoot = path.resolve(root);
    }
    if (isInsideRoot(resolvedRoot, resolvedEntry)) {
      insideAllowedRoot = true;
      break;
    }
  }
  if (!insideAllowedRoot) {
    return { ok: false, reason: "outside_allowed_roots" };
  }

  // Checked on the symlink-resolved path so a renamed link cannot smuggle an
  // arbitrary file in under an allowlisted name.
  const basename = path.basename(resolvedEntry);
  if (
    !(ALLOWED_RENDERER_ENTRY_BASENAMES as readonly string[]).includes(basename)
  ) {
    return { ok: false, reason: "disallowed_basename" };
  }

  return { ok: true, path: resolvedEntry };
}
