import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const targets = ["dist-electron", "dist-react"];

for (const target of targets) {
  const absolutePath = path.join(rootDir, target);
  fs.rmSync(absolutePath, { recursive: true, force: true });
  console.log(`[Clean] Removed ${target}`);
}
