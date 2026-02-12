import fs from "node:fs";
import path from "node:path";
import type { LoggerLikeT } from "./bridge-context.js";
import { resolveDecklinkHelperPath } from "../modules/decklink/decklink-helper.js";
import { resolveDisplayHelperPath } from "../modules/display/display-helper.js";
import { resolveFrameBusNativeCandidates } from "./graphics/framebus/framebus-client.js";

type ArtifactCheckT = {
  label: string;
  artifactPath: string;
  executable?: boolean;
};

const formatStatMode = (mode: number): string => {
  return `0${(mode & 0o777).toString(8)}`;
};

const inspectArtifact = (check: ArtifactCheckT): string => {
  if (!check.artifactPath) {
    return `${check.label}: path is empty`;
  }

  if (!fs.existsSync(check.artifactPath)) {
    return `${check.label}: missing (${check.artifactPath})`;
  }

  const stat = fs.statSync(check.artifactPath);
  let executable = "n/a";
  if (check.executable) {
    try {
      fs.accessSync(check.artifactPath, fs.constants.X_OK);
      executable = "yes";
    } catch {
      executable = "no";
    }
  }

  return `${check.label}: ok path=${check.artifactPath} size=${stat.size} mode=${formatStatMode(
    stat.mode
  )} executable=${executable}`;
};

/**
 * Log runtime diagnostics for native helpers and graphics artifacts.
 *
 * This is used for production triage to verify that packaged files exist
 * and are executable at runtime.
 *
 * @param logger Logger instance from bridge context.
 */
export function logRuntimeDiagnostics(logger: LoggerLikeT): void {
  const runtimeContext = {
    nodeEnv: process.env.NODE_ENV || "",
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    execPath: process.execPath,
    resourcesPath: process.resourcesPath || "",
    electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === "1",
  };
  logger.info(
    `[RuntimeDiagnostics] Context ${JSON.stringify(runtimeContext)}`
  );

  const checks: ArtifactCheckT[] = [
    {
      label: "Bridge entry",
      artifactPath: path.join(process.cwd(), "dist", "index.js"),
    },
    {
      label: "Graphics renderer entry",
      artifactPath: path.join(
        process.cwd(),
        "dist",
        "services",
        "graphics",
        "renderer",
        "electron-renderer-entry.js"
      ),
    },
    {
      label: "DeckLink helper",
      artifactPath: resolveDecklinkHelperPath(),
      executable: true,
    },
    {
      label: "Display helper",
      artifactPath: resolveDisplayHelperPath(),
      executable: true,
    },
  ];

  for (const check of checks) {
    logger.info(`[RuntimeDiagnostics] ${inspectArtifact(check)}`);
  }

  const frameBusCandidates = resolveFrameBusNativeCandidates();
  frameBusCandidates.forEach((candidate, index) => {
    logger.info(
      `[RuntimeDiagnostics] ${inspectArtifact({
        label: `FrameBus candidate #${index + 1}`,
        artifactPath: candidate,
      })}`
    );
  });
}
