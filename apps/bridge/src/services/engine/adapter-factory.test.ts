import { AtemAdapter } from "./adapters/atem-adapter.js";
import { VmixAdapter } from "./adapters/vmix-adapter.js";
import { TricasterAdapter } from "./adapters/tricaster-adapter.js";
import { createEngineAdapter } from "./adapter-factory.js";

describe("createEngineAdapter", () => {
  it("returns AtemAdapter for atem type", () => {
    const adapter = createEngineAdapter("atem");
    expect(adapter).toBeInstanceOf(AtemAdapter);
  });

  it("returns VmixAdapter for vmix type", () => {
    const adapter = createEngineAdapter("vmix");
    expect(adapter).toBeInstanceOf(VmixAdapter);
  });

  it("returns TricasterAdapter for tricaster type", () => {
    const adapter = createEngineAdapter("tricaster");
    expect(adapter).toBeInstanceOf(TricasterAdapter);
  });

  it("throws for unsupported engine type", () => {
    expect(() =>
      createEngineAdapter("unknown" as "atem")
    ).toThrow("Unsupported engine type: unknown");
  });
});
