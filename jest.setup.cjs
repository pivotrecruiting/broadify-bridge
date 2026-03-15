/**
 * Global Jest setup: ensure real timers and clean exit after each test file.
 * Prevents "Jest did not exit" from leftover fake timers or pending work.
 */
afterAll(() => {
  try {
    jest.useRealTimers();
  } catch {
    // ignore if timers were not mocked
  }
});
