import path from "node:path";
import { setBridgeContext } from "../src/services/bridge-context.js";
import { graphicsManager } from "../src/services/graphics/graphics-manager.js";

async function main() {
  setBridgeContext({
    userDataDir: path.join(process.cwd(), ".bridge-data"),
    logger: {
      info: (msg) => console.log(msg),
      warn: (msg) => console.warn(msg),
      error: (msg) => console.error(msg),
    },
  });

  await graphicsManager.initialize();

  await graphicsManager.configureOutputs({
    outputKey: "key_fill_ndi",
    targets: { ndiStreamName: "TEST_STREAM" },
    format: { width: 1920, height: 1080, fps: 50 },
  });

  await graphicsManager.sendLayer({
    layerId: "test-layer",
    category: "lower-thirds",
    backgroundMode: "transparent",
    layout: { x: 0, y: 780, scale: 1 },
    zIndex: 30,
    bundle: {
      manifest: { render: { width: 1920, height: 1080, fps: 50 } },
      html: "<div class='root'>{{title}}</div>",
      css: ".root{color:white;font-size:72px;font-family:Arial;}",
      schema: {},
      defaults: { title: "Hello Graphics" },
      assets: [],
    },
    values: { title: "Render OK" },
  });

  // 5 Sekunden laufen lassen, dann entfernen
  setTimeout(async () => {
    await graphicsManager.removeLayer({ layerId: "test-layer" });
    process.exit(0);
  }, 5000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
