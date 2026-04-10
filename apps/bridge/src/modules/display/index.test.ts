import { DisplayModule } from "./index.js";

describe("display/index", () => {
  it("exports DisplayModule", () => {
    expect(DisplayModule).toBeDefined();
    const module = new DisplayModule();
    expect(module.name).toBe("display");
    expect(typeof module.detect).toBe("function");
    expect(typeof module.createController).toBe("function");
  });
});
