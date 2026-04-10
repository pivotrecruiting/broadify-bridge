import { prepareLayerForRender } from "./graphics-layer-prepare-service.js";

const mockSanitizeTemplateCss = jest.fn((css: string) => css);
const mockValidateTemplate = jest.fn(() => ({ assetIds: new Set<string>() }));
const mockDeriveTemplateBindings = jest.fn(() => ({
  cssVariables: {},
  textContent: {},
  textTypes: {},
  animationClass: "",
}));

jest.mock("./template-sanitizer.js", () => ({
  sanitizeTemplateCss: (css: string) => mockSanitizeTemplateCss(css),
  validateTemplate: (html: string, css: string) => mockValidateTemplate(html, css),
}));

jest.mock("./template-bindings.js", () => ({
  deriveTemplateBindings: (...args: unknown[]) =>
    mockDeriveTemplateBindings(...args),
}));

const mockStoreAsset = jest.fn().mockResolvedValue(undefined);
const mockGetAsset = jest.fn().mockReturnValue(null);
const mockGetAssetMap = jest.fn().mockReturnValue({});

jest.mock("./asset-registry.js", () => ({
  assetRegistry: {
    storeAsset: (...args: unknown[]) => mockStoreAsset(...args),
    getAsset: (id: string) => mockGetAsset(id),
    getAssetMap: () => mockGetAssetMap(),
  },
}));

function createMockRenderer() {
  return {
    setAssets: jest.fn().mockResolvedValue(undefined),
    renderLayer: jest.fn(),
    removeLayer: jest.fn(),
    initialize: jest.fn(),
    configureSession: jest.fn(),
    updateValues: jest.fn(),
    updateLayout: jest.fn(),
    onError: jest.fn(),
    shutdown: jest.fn(),
  };
}

const basePayload = {
  layerId: "layer-1",
  category: "lower_third" as const,
  backgroundMode: "opaque" as const,
  layout: "fill" as const,
  zIndex: 1,
  bundle: {
    html: "<div>Hello</div>",
    css: ".x {}",
    schema: {},
    defaults: {},
  },
};

describe("prepareLayerForRender", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSanitizeTemplateCss.mockImplementation((css: string) => css);
    mockValidateTemplate.mockReturnValue({ assetIds: new Set() });
    mockDeriveTemplateBindings.mockReturnValue({
      cssVariables: {},
      textContent: {},
      textTypes: {},
      animationClass: "",
    });
    mockGetAsset.mockReturnValue(null);
  });

  it("sanitizes CSS and validates template", async () => {
    const renderer = createMockRenderer();

    await prepareLayerForRender(basePayload, "stub", renderer);

    expect(mockSanitizeTemplateCss).toHaveBeenCalledWith(".x {}");
    expect(mockValidateTemplate).toHaveBeenCalledWith(
      "<div>Hello</div>",
      ".x {}"
    );
  });

  it("stores bundle assets and checks assetIds exist", async () => {
    mockValidateTemplate.mockReturnValue({
      assetIds: new Set(["asset-1"]),
    });
    mockGetAsset.mockImplementation((id: string) =>
      id === "asset-1" ? { assetId: "asset-1" } : null
    );
    const renderer = createMockRenderer();
    const payload = {
      ...basePayload,
      bundle: {
        ...basePayload.bundle,
        assets: [
          { assetId: "asset-1", mimeType: "image/png", data: "base64,x" },
        ],
      },
    };

    await prepareLayerForRender(payload, "stub", renderer);

    expect(mockStoreAsset).toHaveBeenCalled();
    expect(renderer.setAssets).toHaveBeenCalled();
  });

  it("throws when referenced asset is missing", async () => {
    mockValidateTemplate.mockReturnValue({
      assetIds: new Set(["missing-asset"]),
    });
    mockGetAsset.mockReturnValue(null);
    const renderer = createMockRenderer();

    await expect(
      prepareLayerForRender(basePayload, "stub", renderer)
    ).rejects.toThrow("Missing asset reference: missing-asset");
  });

  it("enforces transparent background for key_fill_sdi", async () => {
    const renderer = createMockRenderer();

    const result = await prepareLayerForRender(
      { ...basePayload, backgroundMode: "opaque" },
      "key_fill_sdi",
      renderer
    );

    expect(result.backgroundMode).toBe("transparent");
  });

  it("enforces transparent background for key_fill_ndi", async () => {
    const renderer = createMockRenderer();

    const result = await prepareLayerForRender(
      basePayload,
      "key_fill_ndi",
      renderer
    );

    expect(result.backgroundMode).toBe("transparent");
  });

  it("keeps payload backgroundMode for non-alpha outputKey", async () => {
    const renderer = createMockRenderer();

    const result = await prepareLayerForRender(
      { ...basePayload, backgroundMode: "opaque" },
      "video_sdi",
      renderer
    );

    expect(result.backgroundMode).toBe("opaque");
  });

  it("merges bundle defaults and payload values into initialValues", async () => {
    mockDeriveTemplateBindings.mockReturnValue({
      cssVariables: {},
      textContent: { title: "Guest" },
      textTypes: {},
      animationClass: "",
    });
    const renderer = createMockRenderer();
    const payload = {
      ...basePayload,
      bundle: {
        ...basePayload.bundle,
        defaults: { title: "" },
      },
      values: { title: "Guest" },
    };

    const result = await prepareLayerForRender(payload, "stub", renderer);

    expect(result.values).toEqual({ title: "Guest" });
    expect(result.bindings).toEqual(
      expect.objectContaining({ textContent: { title: "Guest" } })
    );
  });
});
