import { parseVmixInputsResponse } from "./vmix-http-client.js";

describe("parseVmixInputsResponse", () => {
  it("parses browser inputs from the vmix xml state response", () => {
    const response = `
      <vmix>
        <inputs>
          <input key="abc123" number="7" title="Broadify Browser Input" shortTitle="Broadify" type="Browser" />
          <input key="cam1" number="1" title="Camera 1" shortTitle="Cam 1" type="Capture" />
        </inputs>
      </vmix>
    `;

    expect(parseVmixInputsResponse(response)).toEqual([
      {
        key: "abc123",
        number: 7,
        title: "Broadify Browser Input",
        shortTitle: "Broadify",
        type: "Browser",
      },
      {
        key: "cam1",
        number: 1,
        title: "Camera 1",
        shortTitle: "Cam 1",
        type: "Capture",
      },
    ]);
  });

  it("decodes xml entities and skips malformed input entries", () => {
    const response = `
      <vmix>
        <inputs>
          <input key="browser-8" number="8" title="Broadify &amp; Overlay" shortTitle="B&amp;O" type="Browser" />
          <input key="broken" title="Missing Number" type="Browser" />
        </inputs>
      </vmix>
    `;

    expect(parseVmixInputsResponse(response)).toEqual([
      {
        key: "browser-8",
        number: 8,
        title: "Broadify & Overlay",
        shortTitle: "B&O",
        type: "Browser",
      },
    ]);
  });
});
