import { DirectionListener, DirectionReading, DirectionSource } from "./types.js";

/**
 * A direction source with no hardware behind it. `inject()` feeds a reading as
 * if it came from a real array — used by unit tests and by the
 * `conference_director_inject` control command so a room can be dry-run (and
 * the switching logic demonstrated) before any microphone array is installed.
 */
export class MockDirectionSource implements DirectionSource {
  readonly kind = "mock";
  private listener: DirectionListener | null = null;
  private connected = false;

  async start(): Promise<void> {
    this.connected = true;
  }

  async stop(): Promise<void> {
    this.connected = false;
  }

  onReading(listener: DirectionListener): void {
    this.listener = listener;
  }

  isConnected(): boolean {
    return this.connected;
  }

  lastError(): string | null {
    return null;
  }

  /** Pushes a reading to the director as if the array had reported it. */
  inject(reading: DirectionReading): void {
    this.listener?.(reading);
  }
}
