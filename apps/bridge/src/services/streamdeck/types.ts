/**
 * Stream Deck integration — shared types.
 *
 * The bridge OWNS the Stream Deck: it renders each key's image and executes the
 * bound action on key-down by calling the existing command router — the same
 * path a webapp button click takes. A hardware device and an in-memory virtual
 * device both implement {@link StreamDeckDevice}, so the whole pipeline
 * (mapping → render → press → execute) is testable without USB hardware.
 */

/** How a key looks: label text, optional icon, colours. */
export type StreamDeckKeyStyle = {
  label?: string;
  /** Optional icon as a data URL (PNG/SVG-rasterized) or absolute file path. */
  icon?: string;
  /** Background hex colour, e.g. "#1e6fff". Defaults to a dark tile. */
  bgColor?: string;
  /** Label hex colour. Defaults to white. */
  textColor?: string;
};

/**
 * What a key does plus how it looks. `command` is normally a relay command
 * (executed via the command router, exactly like a webapp button). Manager-
 * internal paging commands use the {@link STREAMDECK_INTERNAL_PREFIX} and never
 * reach the router.
 */
export type StreamDeckKeyBinding = {
  command: string;
  payload?: Record<string, unknown>;
  style: StreamDeckKeyStyle;
};

/** One page of key bindings. Sparse: unbound key indices render blank. */
export type StreamDeckPage = {
  keys: Record<number, StreamDeckKeyBinding>;
};

/** Physical/virtual key grid. */
export type StreamDeckLayout = {
  columns: number;
  rows: number;
  keyWidth: number;
  keyHeight: number;
};

export type StreamDeckKeyEvent = { keyIndex: number };
export type StreamDeckKeyListener = (event: StreamDeckKeyEvent) => void;

/**
 * Abstraction over a Stream Deck. Implemented by the in-memory
 * VirtualStreamDeck (tests / hardware-free dry-run) and, at hardware bring-up,
 * a node-hid-backed HidStreamDeck. The manager only talks to this interface.
 */
export interface StreamDeckDevice {
  /** "virtual" | "hid". */
  readonly kind: string;
  /** Stable device serial for re-identification, or null. */
  readonly serial: string | null;
  /** Model id, e.g. "virtual-15", "streamdeck-mk2". */
  readonly model: string;
  getLayout(): StreamDeckLayout;
  isConnected(): boolean;
  /** Push an RGBA image (keyWidth*keyHeight*4 bytes) to a key. */
  setKeyImage(keyIndex: number, rgba: Buffer): Promise<void>;
  clearKey(keyIndex: number): Promise<void>;
  clearAll(): Promise<void>;
  setBrightness(percent: number): Promise<void>;
  onKeyDown(listener: StreamDeckKeyListener): void;
  onKeyUp(listener: StreamDeckKeyListener): void;
  close(): Promise<void>;
}

/** Paging and other actions handled by the manager itself, not the router. */
export const STREAMDECK_INTERNAL_PREFIX = "streamdeck:";

export const DEFAULT_STREAMDECK_LAYOUT: StreamDeckLayout = {
  columns: 5,
  rows: 3,
  keyWidth: 72,
  keyHeight: 72,
};
