import { AsyncSerialQueue } from "./async-serial-queue.js";

describe("AsyncSerialQueue", () => {
  it("runs queued async operations strictly in order", async () => {
    const queue = new AsyncSerialQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = queue.enqueue(async () => {
      events.push("second");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("continues processing after a queued operation rejects", async () => {
    const queue = new AsyncSerialQueue();
    const events: string[] = [];

    const first = queue.enqueue(async () => {
      events.push("first");
      throw new Error("boom");
    });
    const second = queue.enqueue(async () => {
      events.push("second");
    });

    await expect(first).rejects.toThrow("boom");
    await second;

    expect(events).toEqual(["first", "second"]);
  });
});
