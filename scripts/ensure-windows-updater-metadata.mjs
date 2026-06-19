import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const distDir = path.join(projectRoot, "dist");
const latestYmlPath = path.join(distDir, "latest.yml");
const packageJson = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
);

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function listRootArtifacts(extension) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(distDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name)
    .sort();
}

async function sha512Base64(filePath) {
  const content = await readFile(filePath);
  return createHash("sha512").update(content).digest("base64");
}

function yamlString(value) {
  return String(value).replace(/'/g, "''");
}

if (await fileExists(latestYmlPath)) {
  console.log("[WinUpdateMetadata] dist/latest.yml already exists.");
  process.exit(0);
}

const exeFiles = await listRootArtifacts(".exe");
if (exeFiles.length !== 1) {
  throw new Error(
    `Expected exactly one root Windows NSIS .exe in dist/, found ${exeFiles.length}.`,
  );
}

const exeName = exeFiles[0];
const exePath = path.join(distDir, exeName);
const blockmapPath = `${exePath}.blockmap`;
if (!(await fileExists(blockmapPath))) {
  throw new Error(`Missing NSIS blockmap: ${blockmapPath}`);
}

const [{ size }, sha512] = await Promise.all([
  stat(exePath),
  sha512Base64(exePath),
]);

const releaseDate = new Date().toISOString();
const latestYml = [
  `version: ${yamlString(packageJson.version)}`,
  "files:",
  `  - url: ${yamlString(exeName)}`,
  `    sha512: ${sha512}`,
  `    size: ${size}`,
  `path: ${yamlString(exeName)}`,
  `sha512: ${sha512}`,
  `releaseDate: '${releaseDate}'`,
  "",
].join("\n");

await writeFile(latestYmlPath, latestYml, "utf8");
console.log(`[WinUpdateMetadata] Generated dist/latest.yml for ${exeName}.`);
