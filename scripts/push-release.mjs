#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT_DIR = process.cwd();
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, "package.json");
const MAIN_BRANCH = "main";

/**
 * Print usage and exit.
 *
 * @param {number} exitCode Process exit code.
 */
function printUsage(exitCode = 0) {
  const usage = `
Usage:
  npm run release:push -- --test --bugfix
  npm run release:push -- --test --feature
  npm run release:push -- --live --bugfix
  npm run release:push -- --live --feature

Convenience:
  npm run release:test -- --bugfix
  npm run release:test -- --feature
  npm run release:live -- --bugfix
  npm run release:live -- --feature

RC continuation / promotion:
  npm run release:test
  npm run release:live

Flags:
  --test       Create an RC tag like v0.12.0-rc.1
  --live       Create a stable tag like v0.12.0
  --bugfix     Bump patch version
  --feature    Bump minor version and reset patch to 0
  --dry-run    Print the planned actions without changing git or files
  --help       Show this help
`;

  process.stdout.write(usage.trimStart());
  process.stdout.write("\n");
  process.exit(exitCode);
}

/**
 * Execute a command and return trimmed stdout.
 *
 * @param {string} command Executable name.
 * @param {string[]} args Command arguments.
 * @returns {string} Trimmed stdout.
 */
function capture(command, args) {
  return execFileSync(command, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Execute a command or print it in dry-run mode.
 *
 * @param {string} command Executable name.
 * @param {string[]} args Command arguments.
 * @param {boolean} dryRun Whether to skip execution.
 */
function run(command, args, dryRun) {
  const rendered = [command, ...args].join(" ");
  if (dryRun) {
    console.log(`[dry-run] ${rendered}`);
    return;
  }

  execFileSync(command, args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
  });
}

/**
 * Parse a semver value with optional rc suffix.
 *
 * @param {string} version Raw version string.
 * @returns {{ major: number, minor: number, patch: number, rc: number | null }}
 */
function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/);
  if (!match) {
    throw new Error(
      `Unsupported version format "${version}". Expected x.y.z or x.y.z-rc.n.`,
    );
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    rc: match[4] ? Number.parseInt(match[4], 10) : null,
  };
}

/**
 * Format a version object back to a semver string.
 *
 * @param {{ major: number, minor: number, patch: number, rc?: number | null }} version Parsed version.
 * @returns {string} Semver string.
 */
function formatVersion(version) {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.rc ? `${base}-rc.${version.rc}` : base;
}

/**
 * Apply the requested semantic bump to a stable base version.
 *
 * @param {{ major: number, minor: number, patch: number }} version Base version.
 * @param {"bugfix" | "feature"} bumpType Requested bump type.
 * @returns {{ major: number, minor: number, patch: number }} Bumped base version.
 */
function bumpBaseVersion(version, bumpType) {
  if (bumpType === "feature") {
    return {
      major: version.major,
      minor: version.minor + 1,
      patch: 0,
    };
  }

  return {
    major: version.major,
    minor: version.minor,
    patch: version.patch + 1,
  };
}

/**
 * Compute the next release version from the current version and CLI options.
 *
 * @param {{ major: number, minor: number, patch: number, rc: number | null }} currentVersion Current version.
 * @param {"test" | "live"} mode Target release mode.
 * @param {"bugfix" | "feature" | null} bumpType Optional bump type.
 * @returns {string} Next version string.
 */
function computeNextVersion(currentVersion, mode, bumpType) {
  const baseVersion = {
    major: currentVersion.major,
    minor: currentVersion.minor,
    patch: currentVersion.patch,
  };

  if (currentVersion.rc !== null) {
    if (mode === "test" && !bumpType) {
      return formatVersion({ ...baseVersion, rc: currentVersion.rc + 1 });
    }

    if (mode === "live" && !bumpType) {
      return formatVersion(baseVersion);
    }

    const bumpedBase = bumpBaseVersion(baseVersion, bumpType);
    return mode === "test"
      ? formatVersion({ ...bumpedBase, rc: 1 })
      : formatVersion(bumpedBase);
  }

  if (!bumpType) {
    throw new Error(
      "Current version is stable. Use either --bugfix or --feature.",
    );
  }

  const bumpedBase = bumpBaseVersion(baseVersion, bumpType);
  return mode === "test"
    ? formatVersion({ ...bumpedBase, rc: 1 })
    : formatVersion(bumpedBase);
}

const rawArgs = new Set(process.argv.slice(2));

if (rawArgs.has("--help")) {
  printUsage(0);
}

const dryRun = rawArgs.has("--dry-run");
const isTest = rawArgs.has("--test");
const isLive = rawArgs.has("--live");
const isBugfix = rawArgs.has("--bugfix");
const isFeature = rawArgs.has("--feature");

if (isTest === isLive) {
  console.error("Use exactly one of --test or --live.");
  printUsage(1);
}

if (isBugfix && isFeature) {
  console.error("Use only one of --bugfix or --feature.");
  printUsage(1);
}

const mode = isTest ? "test" : "live";
const bumpType = isFeature ? "feature" : isBugfix ? "bugfix" : null;

const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
const currentVersion = String(packageJson.version || "").trim();
const parsedCurrentVersion = parseVersion(currentVersion);
const nextVersion = computeNextVersion(parsedCurrentVersion, mode, bumpType);
const nextTag = `v${nextVersion}`;
const commitMessage = `chore(release): cut ${nextTag}`;
const branchName = capture("git", ["branch", "--show-current"]);
const workingTreeStatus = capture("git", ["status", "--porcelain"]);

if (branchName !== MAIN_BRANCH) {
  throw new Error(
    `Release script must run on "${MAIN_BRANCH}". Current branch: "${branchName || "unknown"}".`,
  );
}

if (workingTreeStatus.length > 0) {
  if (dryRun) {
    console.warn(
      "[dry-run] Working tree is not clean. Real execution would stop here.",
    );
  } else {
    throw new Error(
      "Working tree is not clean. Commit or stash your changes before running the release script.",
    );
  }
}

const existingTag = capture("git", ["tag", "--list", nextTag]);
if (existingTag === nextTag) {
  if (dryRun) {
    console.warn(`[dry-run] Tag "${nextTag}" already exists locally.`);
  } else {
    throw new Error(`Git tag "${nextTag}" already exists locally.`);
  }
}

console.log(`Current version: ${currentVersion}`);
console.log(`Next version:    ${nextVersion}`);
console.log(`Release mode:    ${mode}`);
console.log(`Bump type:       ${bumpType ?? "none (rc continuation/promotion)"}`);
console.log(`Git tag:         ${nextTag}`);

run("npm", ["version", "--no-git-tag-version", nextVersion], dryRun);
run("git", ["add", "package.json", "package-lock.json"], dryRun);
run("git", ["commit", "-m", commitMessage], dryRun);
run("git", ["tag", "-a", nextTag, "-m", commitMessage], dryRun);
run("git", ["push", "origin", MAIN_BRANCH], dryRun);
run("git", ["push", "origin", nextTag], dryRun);

console.log(
  dryRun
    ? "Dry-run completed. No files or git refs were changed."
    : `Release pushed successfully: ${nextTag}`,
);
