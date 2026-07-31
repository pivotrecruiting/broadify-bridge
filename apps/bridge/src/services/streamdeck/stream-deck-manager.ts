import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getBridgeContext } from "../bridge-context.js";
import { renderKeyImage } from "./key-renderer.js";
import { VirtualStreamDeck } from "./virtual-stream-deck.js";
import {
  DEFAULT_STREAMDECK_LAYOUT,
  STREAMDECK_INTERNAL_PREFIX,
  STREAMDECK_WEBAPP_PREFIX,
  StreamDeckDevice,
  StreamDeckLayout,
  StreamDeckPage,
} from "./types.js";

/** Executes a resolved relay command — injected so we avoid a router import cycle. */
export type CommandExecutor = (
  command: string,
  payload?: Record<string, unknown>,
) => Promise<unknown> | unknown;

export type StreamDeckConfig = {
  layout?: Partial<StreamDeckLayout>;
  pages: StreamDeckPage[];
  currentPage?: number;
};

const STORE_DIR = "streamdeck";
const STORE_FILE = "mapping.json";

/**
 * Owns the connected Stream Deck (real or virtual), renders the current page of
 * key bindings, and on key-down executes the bound action via the injected
 * command executor — the same command+payload contract a webapp button uses.
 * Paging is handled here (more buttons than keys); the mapping persists to
 * .bridge-data so the deck lights up correctly after a bridge restart.
 */
/** Commands whose keys render state-dependent (see renderCurrentPage). */
const RECORDING_TOGGLE_COMMAND = "meeting_recording_toggle";

/** How long a failed key shows its error style before the page re-renders. */
const ERROR_FLASH_MS = 1500;

/**
 * How long the bridge waits for any browser tab to claim a published webapp
 * action. No claim within this window means no webapp with a mounted meeting
 * page picked the action up — the key flashes red instead of dying silently.
 */
const WEBAPP_ACTION_CLAIM_WINDOW_MS = 5_000;

/**
 * Transport jitter allowed on top of the claim window before an id counts as
 * stale: a throttled background tab that claims minutes later must be denied,
 * not granted (it would execute the action long after the key press).
 */
const WEBAPP_ACTION_CLAIM_JITTER_MS = 2_000;

/**
 * How long the bridge waits for the executing tab's streamdeck_action_result
 * after a granted claim before reporting the key as failed.
 */
const WEBAPP_ACTION_RESULT_WINDOW_MS = 15_000;

/** Hard cap on tracked pending actions - a bound, not a tuning knob. */
const WEBAPP_ACTION_CLAIM_MAX_ENTRIES = 256;

type PendingWebappActionT = {
  keyIndex: number;
  command: string;
  issuedAt: number;
  state: "issued" | "claimed";
  timer: NodeJS.Timeout;
};

/**
 * The command router never throws - it returns `{success: false, error}`.
 * Extract that failure; `null` means the command succeeded (or the result
 * shape is unknown, which we treat as success rather than false-alarming).
 */
export function extractCommandFailure(result: unknown): string | null {
  if (
    typeof result === "object" &&
    result !== null &&
    "success" in result &&
    (result as { success?: unknown }).success === false
  ) {
    const failure = result as { error?: unknown; errorCode?: unknown };
    if (typeof failure.error === "string" && failure.error.length > 0) {
      return failure.error;
    }
    if (typeof failure.errorCode === "string" && failure.errorCode.length > 0) {
      return failure.errorCode;
    }
    return "command_failed";
  }
  return null;
}

export class StreamDeckManager {
  private device: StreamDeckDevice | null = null;
  private pages: StreamDeckPage[] = [{ keys: {} }];
  private currentPage = 0;
  private layoutOverride: Partial<StreamDeckLayout> | undefined;
  private executor: CommandExecutor | null = null;
  private lastError: string | null = null;
  private started = false;
  private startPromise: Promise<void> | null = null;
  private recordingActive = false;
  /** Published webapp actions awaiting their claim and result. */
  private pendingWebappActions = new Map<string, PendingWebappActionT>();
  /** Keys with an action in flight; further presses are ignored until done. */
  private inFlightKeys = new Set<number>();

  /** Provides the action executor (the command router). Call once at wiring. */
  setExecutor(executor: CommandExecutor): void {
    this.executor = executor;
  }

  /**
   * Loads any persisted mapping and attaches a device. Without hardware this is
   * the {@link VirtualStreamDeck}; the real node-hid device drops in later.
   */
  async start(device?: StreamDeckDevice): Promise<void> {
    await this.loadPersisted();
    await this.attachDevice(device ?? new VirtualStreamDeck(this.layoutOverride));
    this.started = true;
  }

  /**
   * Starts once (attaches a virtual device + loads mapping) if not already
   * running. Re-entrant: concurrent callers (hot-plug scan + relay resync)
   * share one start — a second start() used to swap an already attached HID
   * deck for a virtual one, leaving the real deck dark until replug.
   */
  async ensureStarted(): Promise<void> {
    if (this.started) {
      return;
    }
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null;
      });
    }
    await this.startPromise;
  }

  async stop(): Promise<void> {
    for (const pending of this.pendingWebappActions.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingWebappActions.clear();
    this.inFlightKeys.clear();
    if (this.device) {
      await this.device.close();
      this.device = null;
    }
    this.started = false;
  }

  /** Attaches a device, wires key events, and renders the current page. */
  async attachDevice(device: StreamDeckDevice): Promise<void> {
    if (this.device) {
      await this.device.close();
    }
    this.device = device;
    device.onKeyDown((event) => {
      void this.handleKeyDown(event.keyIndex);
    });
    await this.renderCurrentPage();
  }

  /** Replaces the key mapping, persists it, and re-renders. */
  async configure(config: StreamDeckConfig): Promise<void> {
    this.layoutOverride = config.layout ?? this.layoutOverride;
    this.pages = config.pages.length > 0 ? config.pages : [{ keys: {} }];
    this.currentPage = clampPage(config.currentPage ?? this.currentPage, this.pages.length);
    await this.persist();
    await this.renderCurrentPage();
  }

  async setPage(page: number): Promise<void> {
    this.currentPage = clampPage(page, this.pages.length);
    await this.renderCurrentPage();
  }

  /**
   * Reflects the meeting recording state on every key bound to the record
   * toggle (red "REC" while running). Called by the meeting command handler on
   * every start/stop/toggle, so webapp-initiated recordings update the deck
   * too.
   */
  setRecordingActive(active: boolean): void {
    if (this.recordingActive === active) {
      return;
    }
    this.recordingActive = active;
    void this.renderCurrentPage();
  }

  /** Simulates a key press (virtual device / test / `streamdeck_press`). */
  press(keyIndex: number): void {
    if (this.device instanceof VirtualStreamDeck) {
      this.device.press(keyIndex);
    } else {
      void this.handleKeyDown(keyIndex);
    }
  }

  getLayout(): StreamDeckLayout {
    return this.device
      ? this.device.getLayout()
      : { ...DEFAULT_STREAMDECK_LAYOUT, ...this.layoutOverride };
  }

  status(): Record<string, unknown> {
    const layout = this.getLayout();
    return {
      started: this.started,
      connected: this.device?.isConnected() ?? false,
      device_kind: this.device?.kind ?? null,
      model: this.device?.model ?? null,
      serial: this.device?.serial ?? null,
      layout: {
        columns: layout.columns,
        rows: layout.rows,
        key_width: layout.keyWidth,
        key_height: layout.keyHeight,
      },
      page_count: this.pages.length,
      current_page: this.currentPage,
      bound_keys: this.pages.map((p) => Object.keys(p.keys).length),
      // Full mapping so the config UI can render the current assignments.
      pages: this.pages.map((page) => ({
        keys: Object.entries(page.keys).map(([keyIndex, binding]) => ({
          key_index: Number(keyIndex),
          command: binding.command,
          payload: binding.payload ?? null,
          label: binding.style.label ?? null,
          icon: binding.style.icon ?? null,
          bg_color: binding.style.bgColor ?? null,
          text_color: binding.style.textColor ?? null,
        })),
      })),
      last_error: this.lastError,
    };
  }

  private async handleKeyDown(keyIndex: number): Promise<void> {
    const binding = this.pages[this.currentPage]?.keys[keyIndex];
    if (!binding) {
      return;
    }
    if (binding.command.startsWith(STREAMDECK_INTERNAL_PREFIX)) {
      await this.handleInternal(binding.command, binding.payload);
      return;
    }
    // Key spam guard: while an action is in flight (awaiting its executor or
    // the webapp result), further presses on the same key are dropped —
    // otherwise a seemingly dead key spawns N parallel commands.
    if (this.inFlightKeys.has(keyIndex)) {
      return;
    }
    // Notify the webapp so a matching on-screen button can flash "pressed".
    this.publishKeyPressed(binding.command, binding.payload);
    if (binding.command.startsWith(STREAMDECK_WEBAPP_PREFIX)) {
      this.publishWebappAction(
        keyIndex,
        binding.command,
        binding.command.slice(STREAMDECK_WEBAPP_PREFIX.length),
        binding.payload,
      );
      return;
    }
    this.inFlightKeys.add(keyIndex);
    try {
      const result = await this.executor?.(binding.command, binding.payload);
      const failure = extractCommandFailure(result);
      if (failure !== null) {
        this.reportKeyFailure(keyIndex, binding.command, failure);
      }
    } catch (error) {
      // Defensive: the router returns {success:false} instead of throwing, but
      // a future executor might not.
      const message = error instanceof Error ? error.message : String(error);
      this.reportKeyFailure(keyIndex, binding.command, message);
    } finally {
      this.inFlightKeys.delete(keyIndex);
    }
  }

  /**
   * A silently failing key is the worst live failure mode: the operator
   * presses again and again with no idea why nothing happens. Persist the
   * error for the config UI (`status().last_error`), log it, tell the webapp
   * (streamdeck_error event) and flash the key itself.
   */
  private reportKeyFailure(
    keyIndex: number,
    command: string,
    failure: string,
  ): void {
    this.lastError = `${command}: ${failure}`;
    try {
      getBridgeContext().logger.warn(
        `[StreamDeck] Key ${keyIndex} command failed: ${command}: ${failure}`,
      );
      getBridgeContext().publishBridgeEvent?.({
        event: "streamdeck_error",
        data: { key_index: keyIndex, command, error: failure },
      });
    } catch {
      // Context not initialized (standalone tests) - lastError is still set.
    }
    void this.flashKeyError(keyIndex);
  }

  /** Briefly renders the key in an error style, then restores the page. */
  private async flashKeyError(keyIndex: number): Promise<void> {
    const device = this.device;
    if (!device) {
      return;
    }
    try {
      const layout = device.getLayout();
      const rgba = await renderKeyImage(
        { label: "✕", bgColor: "#7f1d1d", textColor: "#ffffff" },
        layout.keyWidth,
        layout.keyHeight,
      );
      await device.setKeyImage(keyIndex, rgba);
    } catch (error) {
      // Rendering the error state must never mask the original failure, but
      // it must not vanish either — on real HID hardware this is the last
      // place a broken render surfaces.
      this.lastError =
        error instanceof Error ? error.message : String(error);
    }
    const restore = setTimeout(() => {
      void this.renderCurrentPage();
    }, ERROR_FLASH_MS);
    restore.unref?.();
  }

  /**
   * Announces a key press to the webapp (command + payload) so an on-screen
   * button bound to the same action can briefly show its pressed state. No-op if
   * no relay is connected.
   */
  private publishKeyPressed(
    command: string,
    payload?: Record<string, unknown>,
  ): void {
    try {
      getBridgeContext().publishBridgeEvent?.({
        event: "streamdeck_key_pressed",
        data: { command, payload: payload ?? null },
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Forwards a webapp-routed action (e.g. a graphics preset) to the open webapp
   * over the relay, so it runs with live state.
   *
   * Delivery is acknowledged end to end: the action is registered as pending,
   * the executing tab must claim it ({@link claimWebappAction}) within the
   * claim window and report back via `streamdeck_action_result`
   * ({@link resolveWebappAction}) within the result window — any gap flashes
   * the key red instead of failing silently.
   */
  private publishWebappAction(
    keyIndex: number,
    command: string,
    action: string,
    payload?: Record<string, unknown>,
  ): void {
    const actionId = randomUUID();
    let publishBridgeEvent;
    try {
      publishBridgeEvent = getBridgeContext().publishBridgeEvent;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reportKeyFailure(keyIndex, command, message);
      return;
    }
    if (!publishBridgeEvent) {
      this.reportKeyFailure(
        keyIndex,
        command,
        "not_delivered: no relay connection to reach a webapp",
      );
      return;
    }
    this.registerPendingWebappAction(actionId, keyIndex, command);
    try {
      publishBridgeEvent({
        event: "streamdeck_action",
        data: { action, payload: payload ?? null, action_id: actionId },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.clearPendingWebappAction(actionId);
      this.reportKeyFailure(keyIndex, command, message);
    }
  }

  private registerPendingWebappAction(
    actionId: string,
    keyIndex: number,
    command: string,
  ): void {
    if (this.pendingWebappActions.size >= WEBAPP_ACTION_CLAIM_MAX_ENTRIES) {
      const oldest = this.pendingWebappActions.keys().next().value;
      if (oldest !== undefined) {
        this.clearPendingWebappAction(oldest);
      }
    }
    const timer = setTimeout(() => {
      this.expirePendingWebappAction(actionId);
    }, WEBAPP_ACTION_CLAIM_WINDOW_MS);
    timer.unref?.();
    this.inFlightKeys.add(keyIndex);
    this.pendingWebappActions.set(actionId, {
      keyIndex,
      command,
      issuedAt: Date.now(),
      state: "issued",
      timer,
    });
  }

  private clearPendingWebappAction(actionId: string): void {
    const pending = this.pendingWebappActions.get(actionId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingWebappActions.delete(actionId);
    this.inFlightKeys.delete(pending.keyIndex);
  }

  private expirePendingWebappAction(actionId: string): void {
    const pending = this.pendingWebappActions.get(actionId);
    if (!pending) {
      return;
    }
    const failure =
      pending.state === "issued"
        ? "not_claimed: no webapp tab with a mounted meeting page picked up the action"
        : "no_result: the webapp claimed the action but never reported a result";
    this.clearPendingWebappAction(actionId);
    this.reportKeyFailure(pending.keyIndex, pending.command, failure);
  }

  /**
   * First-claim-wins arbitration for a broadcast webapp action. Grants only
   * ids the bridge itself issued, that are unclaimed and still fresh: an
   * unknown or expired id is denied so a throttled background tab can never
   * execute an action minutes after the key press (it would also fail the
   * pending bookkeeping). After a bridge restart there are no pending presses,
   * so denying unknown ids is correct. Callers run serialized on the relay
   * concurrency lane, so check-and-set needs no further locking.
   */
  claimWebappAction(actionId: string): boolean {
    const pending = this.pendingWebappActions.get(actionId);
    if (!pending || pending.state !== "issued") {
      return false;
    }
    const age = Date.now() - pending.issuedAt;
    if (age > WEBAPP_ACTION_CLAIM_WINDOW_MS + WEBAPP_ACTION_CLAIM_JITTER_MS) {
      this.expirePendingWebappAction(actionId);
      return false;
    }
    pending.state = "claimed";
    clearTimeout(pending.timer);
    const timer = setTimeout(() => {
      this.expirePendingWebappAction(actionId);
    }, WEBAPP_ACTION_RESULT_WINDOW_MS);
    timer.unref?.();
    pending.timer = timer;
    return true;
  }

  /**
   * Completes a pending webapp action with the executing tab's result. Unknown
   * ids are acknowledged as no-ops (idempotent: the result may arrive after
   * the result window already expired the action).
   */
  resolveWebappAction(
    actionId: string,
    ok: boolean,
    error?: string,
  ): { acknowledged: boolean } {
    const pending = this.pendingWebappActions.get(actionId);
    if (!pending) {
      return { acknowledged: false };
    }
    this.clearPendingWebappAction(actionId);
    if (!ok) {
      this.reportKeyFailure(
        pending.keyIndex,
        pending.command,
        error && error.length > 0 ? error : "webapp_action_failed",
      );
    }
    return { acknowledged: true };
  }

  private async handleInternal(
    command: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const action = command.slice(STREAMDECK_INTERNAL_PREFIX.length);
    if (action === "page_next") {
      await this.setPage(this.currentPage + 1);
    } else if (action === "page_prev") {
      await this.setPage(this.currentPage - 1);
    } else if (action === "page_goto") {
      const page = typeof payload?.page === "number" ? payload.page : 0;
      await this.setPage(page);
    }
  }

  private async renderCurrentPage(): Promise<void> {
    if (!this.device) {
      return;
    }
    const layout = this.device.getLayout();
    const keyCount = layout.columns * layout.rows;
    const page = this.pages[this.currentPage] ?? { keys: {} };
    for (let key = 0; key < keyCount; key += 1) {
      const binding = page.keys[key];
      try {
        if (binding) {
          // Record-toggle keys mirror the live recording state: red "REC ●"
          // while a recording runs, the configured style otherwise.
          const style =
            binding.command === RECORDING_TOGGLE_COMMAND && this.recordingActive
              ? {
                  ...binding.style,
                  label: "REC ●",
                  bgColor: "#dc2626",
                  textColor: "#ffffff",
                }
              : binding.style;
          const rgba = await renderKeyImage(
            style,
            layout.keyWidth,
            layout.keyHeight,
            { command: binding.command, payload: binding.payload },
          );
          await this.device.setKeyImage(key, rgba);
        } else {
          await this.device.clearKey(key);
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  // --- Persistence (.bridge-data/streamdeck/mapping.json) --------------------

  private storePath(): string | null {
    try {
      return path.join(getBridgeContext().userDataDir, STORE_DIR, STORE_FILE);
    } catch {
      return null; // Context not initialized (e.g. standalone tests).
    }
  }

  private async persist(): Promise<void> {
    const file = this.storePath();
    if (!file) {
      return;
    }
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify(
          { layout: this.layoutOverride, pages: this.pages, currentPage: this.currentPage },
          null,
          2,
        ),
        "utf8",
      );
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private async loadPersisted(): Promise<void> {
    const file = this.storePath();
    if (!file) {
      return;
    }
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as StreamDeckConfig;
      if (Array.isArray(parsed.pages) && parsed.pages.length > 0) {
        this.pages = parsed.pages;
      }
      this.layoutOverride = parsed.layout ?? this.layoutOverride;
      this.currentPage = clampPage(parsed.currentPage ?? 0, this.pages.length);
    } catch {
      // No saved mapping yet — start blank.
    }
  }
}

function clampPage(page: number, pageCount: number): number {
  if (pageCount <= 0) {
    return 0;
  }
  return Math.min(pageCount - 1, Math.max(0, Math.trunc(page)));
}

/** Parses the snake_case relay payload from the webapp into a StreamDeckConfig. */
export function parseStreamDeckConfig(
  payload: Record<string, unknown>,
): StreamDeckConfig {
  const layout = parseLayout(payload.layout);
  const rawPages = Array.isArray(payload.pages) ? payload.pages : [];
  const pages: StreamDeckPage[] = rawPages.map((rawPage) => {
    const keys: StreamDeckPage["keys"] = {};
    const rawKeys =
      rawPage && typeof rawPage === "object" && Array.isArray((rawPage as Record<string, unknown>).keys)
        ? ((rawPage as Record<string, unknown>).keys as unknown[])
        : [];
    for (const rawKey of rawKeys) {
      if (!rawKey || typeof rawKey !== "object") {
        continue;
      }
      const k = rawKey as Record<string, unknown>;
      const keyIndex = k.key_index;
      const command = k.command;
      if (typeof keyIndex !== "number" || typeof command !== "string") {
        continue;
      }
      keys[keyIndex] = {
        command,
        payload:
          k.payload && typeof k.payload === "object"
            ? (k.payload as Record<string, unknown>)
            : undefined,
        style: {
          label: typeof k.label === "string" ? k.label : undefined,
          icon: typeof k.icon === "string" ? k.icon : undefined,
          bgColor: typeof k.bg_color === "string" ? k.bg_color : undefined,
          textColor: typeof k.text_color === "string" ? k.text_color : undefined,
        },
      };
    }
    return { keys };
  });
  return {
    layout,
    pages: pages.length > 0 ? pages : [{ keys: {} }],
    currentPage: typeof payload.current_page === "number" ? payload.current_page : undefined,
  };
}

function parseLayout(raw: unknown): Partial<StreamDeckLayout> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const l = raw as Record<string, unknown>;
  const layout: Partial<StreamDeckLayout> = {};
  if (typeof l.columns === "number") layout.columns = l.columns;
  if (typeof l.rows === "number") layout.rows = l.rows;
  if (typeof l.key_width === "number") layout.keyWidth = l.key_width;
  if (typeof l.key_height === "number") layout.keyHeight = l.key_height;
  return Object.keys(layout).length > 0 ? layout : undefined;
}

/** Process-wide singleton, mirroring the conference/display services. */
export const streamDeckManager = new StreamDeckManager();
