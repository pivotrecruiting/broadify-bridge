#!/usr/bin/env node
/**
 * Local release build wrapper. CI provides its environment via secrets; for
 * local dist runs this loads apps/bridge/.env the same way the app does and
 * fixes the known local-build pitfalls:
 * - PORT from .env leaks into the jest suite and breaks the electron util
 *   tests -> stripped for the build.
 * - APPLE_API_KEY is stored as PEM content but notarytool expects a .p8 file
 *   path -> written to ~/.broadify-notary-key.p8 (mode 600).
 *
 * Usage: node scripts/dist-local.mjs   (macOS arm64 or Windows x64)
 * Extra env (macOS): VCAM_SIGNING_MODE=developer-id when no Apple
 * Development cert is installed; MACOS_FLOOR_VERSION=15.0 when the local
 * SDL2 build exceeds the release floor (test RCs only).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("../apps/bridge/node_modules/dotenv").config({
  path: path.join("apps", "bridge", ".env"),
});

delete process.env.PORT;

const rawAppleKey = process.env.APPLE_API_KEY || "";
if (rawAppleKey.includes("BEGIN PRIVATE KEY")) {
  const base64 = rawAppleKey
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const body = base64.match(/.{1,64}/g).join("\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
  const keyPath = path.join(os.homedir(), ".broadify-notary-key.p8");
  fs.writeFileSync(keyPath, pem, { mode: 0o600 });
  process.env.APPLE_API_KEY = keyPath;
}

const target = process.platform === "win32" ? "dist:win" : "dist:mac:arm64";
console.log(`[dist-local] running npm run ${target}`);
const result = spawnSync("npm", ["run", target], {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
