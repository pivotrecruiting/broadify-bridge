import {
  DEFAULT_STREAMDECK_LAYOUT,
  StreamDeckDevice,
  StreamDeckKeyListener,
  StreamDeckLayout,
} from "./types.js";

/**
 * An in-memory Stream Deck with no hardware behind it. It stores the last image
 * pushed to each key and lets tests / the `streamdeck_press` command simulate
 * key presses, so the full mapping → render → press → execute pipeline runs
 * without a physical device. A real node-hid-backed device implements the same
 * {@link StreamDeckDevice} interface and drops in at hardware bring-up.
 */
export class VirtualStreamDeck implements StreamDeckDevice {
  readonly kind = "virtual";
  readonly serial: string | null;
  readonly model: string;
  private readonly layout: StreamDeckLayout;
  private readonly images = new Map<number, Buffer>();
  private readonly downListeners: StreamDeckKeyListener[] = [];
  private readonly upListeners: StreamDeckKeyListener[] = [];
  private brightness = 80;
  private connected = true;

  constructor(layout?: Partial<StreamDeckLayout>) {
    this.layout = { ...DEFAULT_STREAMDECK_LAYOUT, ...layout };
    this.model = `virtual-${this.layout.columns * this.layout.rows}`;
    this.serial = `VIRTUAL-${this.model}`;
  }

  getLayout(): StreamDeckLayout {
    return this.layout;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async setKeyImage(keyIndex: number, rgba: Buffer): Promise<void> {
    this.images.set(keyIndex, rgba);
  }

  async clearKey(keyIndex: number): Promise<void> {
    this.images.delete(keyIndex);
  }

  async clearAll(): Promise<void> {
    this.images.clear();
  }

  async setBrightness(percent: number): Promise<void> {
    this.brightness = Math.min(100, Math.max(0, percent));
  }

  onKeyDown(listener: StreamDeckKeyListener): void {
    this.downListeners.push(listener);
  }

  onKeyUp(listener: StreamDeckKeyListener): void {
    this.upListeners.push(listener);
  }

  async close(): Promise<void> {
    this.connected = false;
    this.images.clear();
    this.downListeners.length = 0;
    this.upListeners.length = 0;
  }

  // --- Test / dry-run helpers -----------------------------------------------

  /** Simulates a full press (down then up) of a key. */
  press(keyIndex: number): void {
    for (const listener of [...this.downListeners]) {
      listener({ keyIndex });
    }
    for (const listener of [...this.upListeners]) {
      listener({ keyIndex });
    }
  }

  /** Returns the last RGBA image pushed to a key (for assertions/preview). */
  getKeyImage(keyIndex: number): Buffer | undefined {
    return this.images.get(keyIndex);
  }

  getBrightness(): number {
    return this.brightness;
  }
}
