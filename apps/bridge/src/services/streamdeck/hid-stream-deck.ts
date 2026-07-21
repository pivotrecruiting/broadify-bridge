import {
  listStreamDecks,
  openStreamDeck,
} from "@elgato-stream-deck/node";
import type {
  StreamDeck,
  StreamDeckButtonControlDefinition,
  StreamDeckControlDefinition,
} from "@elgato-stream-deck/node";
import type { StreamDeckManager } from "./stream-deck-manager.js";
import { VirtualStreamDeck } from "./virtual-stream-deck.js";
import { getBridgeContext, type LoggerLikeT } from "../bridge-context.js";
import {
  StreamDeckDevice,
  StreamDeckKeyListener,
  StreamDeckLayout,
} from "./types.js";

const DEFAULT_KEY_SIZE = 72;
const HOTPLUG_SCAN_INTERVAL_MS = 2000;

/** Bridge pino logger, falling back to console before the context is set. */
function log(): LoggerLikeT {
  try {
    return getBridgeContext().logger;
  } catch {
    return console;
  }
}

type ButtonFeedback = StreamDeckButtonControlDefinition["feedbackType"];

function isButton(
  control: StreamDeckControlDefinition,
): control is StreamDeckButtonControlDefinition {
  return control.type === "button";
}

/** Mean colour of an RGBA buffer — used for RGB-only keys (no LCD). */
function averageRgb(rgba: Buffer): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    r += rgba[i];
    g += rgba[i + 1];
    b += rgba[i + 2];
    count += 1;
  }
  if (count === 0) {
    return { r: 0, g: 0, b: 0 };
  }
  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
  };
}

/**
 * Real Stream Deck over USB HID, wrapping {@link @elgato-stream-deck/node}. It
 * implements the same {@link StreamDeckDevice} interface as the virtual deck, so
 * the manager's render → press → execute pipeline is unchanged. Layout (grid +
 * key pixel size) and per-key feedback type are read from the device, so every
 * model works: LCD keys get the rendered image, RGB-only keys get the mean
 * colour, and input-only controls (e.g. Stream Deck Pedal) just fire presses.
 */
export class HidStreamDeck implements StreamDeckDevice {
  readonly kind = "hid";
  readonly serial: string | null;
  readonly model: string;
  private readonly deck: StreamDeck;
  private readonly layout: StreamDeckLayout;
  private readonly feedbackByKey: Map<number, ButtonFeedback>;
  private readonly downListeners: StreamDeckKeyListener[] = [];
  private readonly upListeners: StreamDeckKeyListener[] = [];
  private connected = true;

  private constructor(
    deck: StreamDeck,
    serial: string | null,
    layout: StreamDeckLayout,
    feedbackByKey: Map<number, ButtonFeedback>,
  ) {
    this.deck = deck;
    this.serial = serial;
    this.model = deck.MODEL;
    this.layout = layout;
    this.feedbackByKey = feedbackByKey;

    deck.on("down", (control) => {
      if (control.type === "button") {
        for (const listener of [...this.downListeners]) {
          listener({ keyIndex: control.index });
        }
      }
    });
    deck.on("up", (control) => {
      if (control.type === "button") {
        for (const listener of [...this.upListeners]) {
          listener({ keyIndex: control.index });
        }
      }
    });
  }

  /** Opens the device at a USB path and reads its geometry. */
  static async open(devicePath: string): Promise<HidStreamDeck> {
    const deck = await openStreamDeck(devicePath);
    const buttons = deck.CONTROLS.filter(isButton);
    const columns =
      buttons.length > 0
        ? Math.max(...buttons.map((button) => button.column)) + 1
        : 0;
    const rows =
      buttons.length > 0
        ? Math.max(...buttons.map((button) => button.row)) + 1
        : 0;
    const lcdButton = buttons.find((button) => button.feedbackType === "lcd");
    const keyWidth =
      lcdButton && lcdButton.feedbackType === "lcd"
        ? lcdButton.pixelSize.width
        : DEFAULT_KEY_SIZE;
    const keyHeight =
      lcdButton && lcdButton.feedbackType === "lcd"
        ? lcdButton.pixelSize.height
        : DEFAULT_KEY_SIZE;
    const feedbackByKey = new Map<number, ButtonFeedback>(
      buttons.map((button) => [button.index, button.feedbackType]),
    );
    const serial = await deck.getSerialNumber().catch(() => null);
    log().info(
      `[streamdeck] opened ${deck.MODEL}: grid ${columns}x${rows}, key ${keyWidth}x${keyHeight}px, buttons=${buttons.length}, feedback=[${buttons
        .map((b) => `${b.index}:${b.feedbackType}`)
        .join(" ")}]`,
    );
    return new HidStreamDeck(
      deck,
      serial,
      { columns, rows, keyWidth, keyHeight },
      feedbackByKey,
    );
  }

  getLayout(): StreamDeckLayout {
    return this.layout;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async setKeyImage(keyIndex: number, rgba: Buffer): Promise<void> {
    const feedback = this.feedbackByKey.get(keyIndex);
    try {
      if (feedback === "lcd") {
        await this.deck.fillKeyBuffer(keyIndex, rgba, { format: "rgba" });
      } else if (feedback === "rgb") {
        const { r, g, b } = averageRgb(rgba);
        await this.deck.fillKeyColor(keyIndex, r, g, b);
      }
      // feedback "none" (e.g. Stream Deck Pedal): no display to update.
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log().error(
        `[streamdeck] setKeyImage(key=${keyIndex}, feedback=${feedback}, bytes=${rgba.length}) failed: ${reason}`,
      );
    }
  }

  async clearKey(keyIndex: number): Promise<void> {
    const feedback = this.feedbackByKey.get(keyIndex);
    if (feedback === "lcd" || feedback === "rgb") {
      await this.deck.clearKey(keyIndex);
    }
  }

  async clearAll(): Promise<void> {
    await this.deck.clearPanel();
  }

  async setBrightness(percent: number): Promise<void> {
    const clamped = Math.min(100, Math.max(0, Math.round(percent)));
    await this.deck.setBrightness(clamped);
  }

  onKeyDown(listener: StreamDeckKeyListener): void {
    this.downListeners.push(listener);
  }

  onKeyUp(listener: StreamDeckKeyListener): void {
    this.upListeners.push(listener);
  }

  async close(): Promise<void> {
    this.connected = false;
    this.downListeners.length = 0;
    this.upListeners.length = 0;
    try {
      await this.deck.close();
    } catch {
      // The device may already be gone (unplugged); closing is best-effort.
    }
  }
}

export type StreamDeckHardwareWatch = { stop: () => void };

/**
 * Polls for a connected Stream Deck and keeps the manager attached to it: on
 * connect it opens the device and attaches it (the manager re-renders the
 * active page); on disconnect it falls back to the virtual device. Opening can
 * fail if the Elgato Stream Deck app is running (it claims the device) — that is
 * logged and retried on the next scan. A single flight guard prevents
 * overlapping scans.
 */
export function startStreamDeckHardwareWatch(
  manager: StreamDeckManager,
  log: (message: string) => void = () => {},
): StreamDeckHardwareWatch {
  let attachedPath: string | null = null;
  let scanning = false;

  const scan = async (): Promise<void> => {
    if (scanning) {
      return;
    }
    scanning = true;
    try {
      await manager.ensureStarted();
      const decks = await listStreamDecks();
      const present = decks[0] ?? null;

      if (present && present.path !== attachedPath) {
        try {
          const device = await HidStreamDeck.open(present.path);
          attachedPath = present.path;
          await manager.attachDevice(device);
          log(
            `Stream Deck connected: ${device.model} (${device.serial ?? "no serial"})`,
          );
        } catch (error) {
          // Likely claimed by the Elgato app or a permissions issue; retry.
          attachedPath = null;
          log(
            `Stream Deck open failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else if (!present && attachedPath) {
        attachedPath = null;
        await manager.attachDevice(new VirtualStreamDeck());
        log("Stream Deck disconnected; using the virtual device.");
      }
    } catch (error) {
      log(
        `Stream Deck scan error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      scanning = false;
    }
  };

  const timer = setInterval(() => void scan(), HOTPLUG_SCAN_INTERVAL_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  void scan();
  return {
    stop: () => clearInterval(timer),
  };
}
