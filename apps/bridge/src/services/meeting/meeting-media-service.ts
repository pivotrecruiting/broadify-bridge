import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
} from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";

import { getBridgeContext } from "../bridge-context.js";

export type MeetingMediaRenderStatusT =
  | "queued"
  | "processing"
  | "ready"
  | "error";

export type MeetingMediaSourceFormatT = "pptx" | "pdf";

export type MeetingMediaRuntimeStatusT =
  | "ready"
  | "unavailable"
  | "unsupported_platform";

export type MeetingMediaPageT = {
  page: number;
  imagePath: string;
  width: number | null;
  height: number | null;
};

export type MeetingMediaAssetT = {
  assetId: string;
  filename: string;
  sourceFormat: MeetingMediaSourceFormatT;
  originalPath: string;
  createdAt: string;
  updatedAt: string;
  renderStatus: MeetingMediaRenderStatusT;
  renderMessage: string | null;
  pageCount: number;
  pages: MeetingMediaPageT[];
};

const MAX_MEDIA_FILE_BYTES = 500 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 180_000;
const TARGET_PAGE_WIDTH = 1920;
const BUNDLED_LIBREOFFICE_RELATIVE_PATH = join(
  "presentation-runtime",
  "macos-arm64",
  "LibreOffice.app",
  "Contents",
  "MacOS",
  "soffice",
);

type LoggerT = {
  warn: (msg: string) => void;
  info: (msg: string) => void;
};

const getLogger = (): LoggerT => {
  try {
    return getBridgeContext().logger;
  } catch {
    return {
      info: (msg: string) => console.info(msg),
      warn: (msg: string) => console.warn(msg),
    };
  }
};

const safeFilename = (filename: string): string => {
  const cleaned = basename(filename || "presentation").replace(
    /[^A-Za-z0-9._-]+/g,
    "-",
  );
  return cleaned.replace(/^-+|-+$/g, "") || "presentation";
};

const inferSourceFormat = (filename: string): MeetingMediaSourceFormatT => {
  const suffix = extname(filename).toLowerCase();
  if (suffix === ".pptx") {
    return "pptx";
  }
  if (suffix === ".pdf") {
    return "pdf";
  }
  throw new Error("Only PPTX and PDF meeting content files are supported.");
};

const getRuntimeDir = (): string => {
  try {
    return join(getBridgeContext().userDataDir, "meeting-media");
  } catch {
    return join(process.cwd(), ".broadify-meeting-media");
  }
};

const metadataPath = (assetDir: string): string => join(assetDir, "metadata.json");

const resolveBundledLibreOffice = (): string | null => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return null;
  }

  const configuredRuntimeRoot = process.env.BROADIFY_PRESENTATION_RUNTIME_DIR;
  const runtimeRoot = configuredRuntimeRoot
    ? isAbsolute(configuredRuntimeRoot)
      ? configuredRuntimeRoot
      : resolve(configuredRuntimeRoot)
    : null;
  const candidates = [
    runtimeRoot ? join(runtimeRoot, "LibreOffice.app", "Contents", "MacOS", "soffice") : null,
    process.resourcesPath
      ? join(process.resourcesPath, BUNDLED_LIBREOFFICE_RELATIVE_PATH)
      : null,
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

const getRuntimeStatus = (): MeetingMediaRuntimeStatusT => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return "unsupported_platform";
  }
  return resolveBundledLibreOffice() ? "ready" : "unavailable";
};

const runProcess = (
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => fail(error));
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error((stderr || stdout || `${command} exited with ${code}`).trim()));
    });
  });

class NapiCanvasFactory {
  constructor(_options: { enableHWA?: boolean } = {}) {}

  create(width: number, height: number) {
    const canvas = createCanvas(width, height);
    return {
      canvas,
      context: canvas.getContext("2d"),
    };
  }

  reset(
    canvasAndContext: { canvas: ReturnType<typeof createCanvas> },
    width: number,
    height: number,
  ) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext: { canvas: ReturnType<typeof createCanvas> }) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
  }
}

/**
 * Stores and renders local meeting presentation assets for the native helper.
 */
class MeetingMediaService {
  private readonly renderJobs = new Set<string>();
  private renderQueue: Promise<void> = Promise.resolve();

  async saveUpload(
    filename: string,
    payload: Readable,
  ): Promise<MeetingMediaAssetT> {
    const safeName = safeFilename(filename);
    const sourceFormat = inferSourceFormat(safeName);
    const assetId = `${Date.now()}-${randomUUID().slice(0, 10)}`;
    const assetDir = join(getRuntimeDir(), assetId);
    const originalPath = join(assetDir, safeName);
    const temporaryPath = join(assetDir, `${safeName}.uploading`);
    await mkdir(assetDir, { recursive: true });

    try {
      await this.writeUpload(payload, temporaryPath);
      await rename(temporaryPath, originalPath);
    } catch (error) {
      await rm(assetDir, { recursive: true, force: true });
      throw error;
    }

    const now = new Date().toISOString();
    const asset: MeetingMediaAssetT = {
      assetId,
      filename: safeName,
      sourceFormat,
      originalPath,
      createdAt: now,
      updatedAt: now,
      renderStatus: "queued",
      renderMessage: "Presentation rendering is queued.",
      pageCount: 0,
      pages: [],
    };
    await this.writeAsset(asset);
    void this.enqueueRender(assetId);
    return asset;
  }

  async listAssets(): Promise<MeetingMediaAssetT[]> {
    const root = getRuntimeDir();
    if (!existsSync(root)) {
      return [];
    }
    const entries = await readdir(root, { withFileTypes: true });
    const assets = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.getAsset(entry.name).catch(() => null)),
    );
    return assets
      .filter((asset): asset is MeetingMediaAssetT => asset !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getAsset(assetId: string): Promise<MeetingMediaAssetT> {
    const assetDir = this.assetDir(assetId);
    const raw = await readFile(metadataPath(assetDir), "utf8");
    return JSON.parse(raw) as MeetingMediaAssetT;
  }

  async deleteAsset(assetId: string): Promise<{ ok: true; assetId: string }> {
    await rm(this.assetDir(assetId), { recursive: true, force: true });
    return { ok: true, assetId };
  }

  async renderingStatus(): Promise<Record<string, unknown>> {
    const runtimeStatus = getRuntimeStatus();
    return {
      // PDF is rendered by pdf.js + @napi-rs/canvas (cross-platform); only PPTX
      // needs the bundled LibreOffice runtime.
      pdfSupported: true,
      pptxSupported: runtimeStatus === "ready",
      runtimeStatus,
      renderer: "pdfjs-napi-canvas",
      activeJobs: this.renderJobs.size,
      maxUploadBytes: MAX_MEDIA_FILE_BYTES,
    };
  }

  async renderAsset(assetId: string): Promise<void> {
    if (this.renderJobs.has(assetId)) {
      return;
    }
    this.renderJobs.add(assetId);
    const logger = getLogger();
    try {
      let asset = await this.getAsset(assetId);
      const runtimeStatus = getRuntimeStatus();
      // Only PPTX needs the bundled presentation runtime (LibreOffice) to
      // convert to PDF first. PDF is rendered directly by pdf.js + @napi-rs/canvas,
      // which are cross-platform, so a PDF upload works on every platform.
      if (asset.sourceFormat === "pptx" && runtimeStatus !== "ready") {
        throw new Error(
          runtimeStatus === "unsupported_platform"
            ? "PPTX conversion needs the bundled presentation runtime (LibreOffice), which is currently macOS Apple Silicon only. Export the slides to PDF and upload that instead."
            : "The bundled presentation runtime is unavailable.",
        );
      }
      asset = await this.updateAsset(asset, {
        renderStatus: "processing",
        renderMessage: "Rendering presentation pages.",
        pages: [],
        pageCount: 0,
      });
      const pdfPath =
        asset.sourceFormat === "pptx"
          ? await this.convertPptxToPdf(asset)
          : asset.originalPath;
      const pages = await this.renderPdfPages(asset, pdfPath);
      await this.updateAsset(asset, {
        renderStatus: "ready",
        renderMessage: null,
        pages,
        pageCount: pages.length,
      });
      logger.info(`[MeetingMedia] Rendered ${pages.length} page(s) for ${asset.assetId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[MeetingMedia] Render failed for ${assetId}: ${message}`);
      try {
        const asset = await this.getAsset(assetId);
        await this.updateAsset(asset, {
          renderStatus: "error",
          renderMessage: message,
          pages: [],
          pageCount: 0,
        });
      } catch {
        // Ignore metadata write errors after a failed render.
      }
    } finally {
      this.renderJobs.delete(assetId);
    }
  }

  getPageImagePath(asset: MeetingMediaAssetT, page: number): string | null {
    const target = asset.pages[Math.max(0, Math.min(page, asset.pages.length - 1))];
    return target?.imagePath ?? null;
  }

  private async enqueueRender(assetId: string): Promise<void> {
    const job = this.renderQueue.then(() => this.renderAsset(assetId));
    this.renderQueue = job.catch(() => undefined);
    await job;
  }

  private async writeUpload(payload: Readable, destination: string): Promise<void> {
    let bytesWritten = 0;
    payload.on("data", (chunk: Buffer) => {
      bytesWritten += chunk.length;
      if (bytesWritten > MAX_MEDIA_FILE_BYTES) {
        payload.destroy(
          new Error("Meeting content file exceeds the 500 MB limit."),
        );
      }
    });
    await pipeline(payload, createWriteStream(destination, { flags: "wx" }));
    if (bytesWritten === 0) {
      throw new Error("Uploaded meeting content file is empty.");
    }
  }

  private async convertPptxToPdf(asset: MeetingMediaAssetT): Promise<string> {
    const libreOffice = resolveBundledLibreOffice();
    if (!libreOffice) {
      throw new Error("The bundled PowerPoint conversion runtime is unavailable.");
    }
    const outDir = join(dirname(asset.originalPath), "converted");
    const profileDir = join(dirname(asset.originalPath), "libreoffice-profile");
    await mkdir(outDir, { recursive: true });
    await rm(profileDir, { recursive: true, force: true });
    await mkdir(profileDir, { recursive: true });
    await runProcess(
      libreOffice,
      [
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        outDir,
        asset.originalPath,
      ],
      RENDER_TIMEOUT_MS,
    );
    const pdfPath = join(outDir, `${basename(asset.originalPath, extname(asset.originalPath))}.pdf`);
    if (!existsSync(pdfPath)) {
      throw new Error("PPTX to PDF conversion did not produce a PDF file.");
    }
    return pdfPath;
  }

  private async renderPdfPages(
    asset: MeetingMediaAssetT,
    pdfPath: string,
  ): Promise<MeetingMediaPageT[]> {
    const outputDir = join(dirname(asset.originalPath), "rendered");
    await mkdir(outputDir, { recursive: true });

    Object.assign(globalThis, {
      DOMMatrix,
      ImageData,
      Path2D,
    });
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      CanvasFactory: NapiCanvasFactory,
      data: new Uint8Array(await readFile(pdfPath)),
    });
    const document = await loadingTask.promise;
    const pages: MeetingMediaPageT[] = [];
    try {
      for (let index = 1; index <= document.numPages; index += 1) {
        const pdfPage = await document.getPage(index);
        const baseViewport = pdfPage.getViewport({ scale: 1 });
        const scale = Math.max(1, TARGET_PAGE_WIDTH / Math.max(1, baseViewport.width));
        const viewport = pdfPage.getViewport({ scale });
        const canvas = createCanvas(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
        const context = canvas.getContext("2d");
        const renderParameters = {
          canvas: canvas as never,
          canvasContext: context as never,
          viewport,
        } as never;
        await pdfPage.render(renderParameters).promise;
        const imagePath = join(outputDir, `page-${String(index).padStart(4, "0")}.png`);
        await writeFile(imagePath, canvas.toBuffer("image/png"));
        pages.push({
          page: index - 1,
          imagePath,
          width: canvas.width,
          height: canvas.height,
        });
        pdfPage.cleanup();
      }
    } finally {
      await document.destroy();
    }
    if (pages.length === 0) {
      throw new Error("Presentation rendered zero pages.");
    }
    return pages;
  }

  private assetDir(assetId: string): string {
    if (!/^[A-Za-z0-9_-]+-[A-Za-z0-9_-]+$/.test(assetId)) {
      throw new Error("Invalid meeting media asset ID.");
    }
    return join(getRuntimeDir(), assetId);
  }

  private async updateAsset(
    asset: MeetingMediaAssetT,
    patch: Partial<MeetingMediaAssetT>,
  ): Promise<MeetingMediaAssetT> {
    const next = {
      ...asset,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.writeAsset(next);
    return next;
  }

  private async writeAsset(asset: MeetingMediaAssetT): Promise<void> {
    const assetDir = dirname(asset.originalPath);
    await mkdir(assetDir, { recursive: true });
    await writeFile(metadataPath(assetDir), JSON.stringify(asset, null, 2), "utf8");
  }
}

export const meetingMediaService = new MeetingMediaService();
