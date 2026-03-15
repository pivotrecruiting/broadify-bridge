/**
 * FrameBus-specific error classes.
 * Extracted for testability (framebus-client uses import.meta.url which Jest does not transform).
 */
export class InvalidHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidHeaderError";
  }
}

export class FrameSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameSizeError";
  }
}

export class OpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenError";
  }
}
