/**
 * Serialize async operations while preserving enqueue order.
 *
 * Each enqueued operation still returns its own promise, but the internal
 * queue always continues even if a previous operation rejects.
 */
export class AsyncSerialQueue {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Enqueue an async operation behind the current queue tail.
   *
   * @param operation Async work item.
   * @returns Promise resolved or rejected with the operation result.
   */
  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Wait until all currently queued operations complete.
   */
  async drain(): Promise<void> {
    await this.tail;
  }
}
