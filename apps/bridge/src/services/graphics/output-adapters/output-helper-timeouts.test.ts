import {
  DECKLINK_OUTPUT_HELPER_READY_TIMEOUT_MS,
  DISPLAY_OUTPUT_HELPER_READY_TIMEOUT_MS,
} from "./output-helper-timeouts.js";

describe("output-helper-timeouts", () => {
  it("keeps the ready budgets the adapters shipped with", () => {
    expect(DISPLAY_OUTPUT_HELPER_READY_TIMEOUT_MS).toBe(8_000);
    expect(DECKLINK_OUTPUT_HELPER_READY_TIMEOUT_MS).toBe(12_000);
  });
});
