import { sanitizeTemplateCss, validateTemplate } from "./template-sanitizer.js";

describe("sanitizeTemplateCss", () => {
  it("returns empty string for empty input", () => {
    expect(sanitizeTemplateCss("")).toBe("");
    expect(sanitizeTemplateCss("   ")).toBe("");
  });

  it("removes block comments", () => {
    expect(sanitizeTemplateCss("a { color: red; } /* comment */ b {}")).toBe(
      "a { color: red; }  b {}"
    );
  });

  it("removes block comment; first */ closes comment", () => {
    expect(sanitizeTemplateCss("/* outer /* inner */ outer */ .x{}")).toBe(
      "outer */ .x{}"
    );
  });

  it("preserves strings containing comment-like sequences", () => {
    expect(sanitizeTemplateCss('a { content: "/* not a comment */"; }')).toBe(
      'a { content: "/* not a comment */"; }'
    );
  });

  it("preserves single-quoted strings", () => {
    expect(sanitizeTemplateCss("a { font: 'Arial'; }")).toBe(
      "a { font: 'Arial'; }"
    );
  });

  it("preserves escaped quotes in strings", () => {
    expect(sanitizeTemplateCss('a { content: "say \\"hi\\""; }')).toBe(
      'a { content: "say \\"hi\\""; }'
    );
  });

  it("trims result", () => {
    expect(sanitizeTemplateCss("  .foo { }  ")).toBe(".foo { }");
  });
});

describe("validateTemplate", () => {
  const validHtml = "<div>Hello</div>";
  const validCss = ".foo { color: red; }";

  it("returns assetIds from asset:// URLs in html and css", () => {
    const result = validateTemplate(
      '<div><img src="asset://logo-1"></div>',
      ".bg { background: url(asset://bg-2); }"
    );
    expect(result.assetIds).toEqual(new Set(["logo-1", "bg-2"]));
  });

  it("returns empty assetIds when no asset URLs", () => {
    const result = validateTemplate(validHtml, validCss);
    expect(result.assetIds).toEqual(new Set());
  });

  it("throws on <script> in html", () => {
    expect(() =>
      validateTemplate("<div><script>alert(1)</script></div>", validCss)
    ).toThrow("Template HTML contains <script> tags");
  });

  it("throws on inline event handlers", () => {
    expect(() =>
      validateTemplate('<div onclick="alert(1)">x</div>', validCss)
    ).toThrow("Template HTML contains inline event handlers");
  });

  it("throws on iframe", () => {
    expect(() =>
      validateTemplate("<div><iframe src='x'></iframe></div>", validCss)
    ).toThrow("Template HTML contains iframes");
  });

  it("throws on object/embed tags", () => {
    expect(() =>
      validateTemplate("<div><object data='x'></object></div>", validCss)
    ).toThrow("Template HTML contains embed/object tags");
    expect(() =>
      validateTemplate("<div><embed src='x'></embed></div>", validCss)
    ).toThrow("Template HTML contains embed/object tags");
  });

  it("throws on link tags", () => {
    expect(() =>
      validateTemplate("<div><link rel='stylesheet' href='x'></div>", validCss)
    ).toThrow("Template HTML contains <link> tags");
  });

  it("throws on javascript: URLs in html", () => {
    expect(() =>
      validateTemplate('<a href="javascript:void(0)">x</a>', validCss)
    ).toThrow("Template contains javascript: URLs");
  });

  it("throws on javascript: URLs in css", () => {
    expect(() =>
      validateTemplate(validHtml, "a { background: url(javascript:alert(1)); }")
    ).toThrow("Template contains javascript: URLs");
  });

  it("throws on external URLs in html", () => {
    expect(() =>
      validateTemplate('<a href="https://evil.com">x</a>', validCss)
    ).toThrow("Template contains external URLs");
  });

  it("throws on external URLs in css", () => {
    expect(() =>
      validateTemplate(validHtml, "a { background: url(https://evil.com/x); }")
    ).toThrow("Template contains external URLs");
  });

  it("throws on data: URLs", () => {
    expect(() =>
      validateTemplate('<img src="data:image/png;base64,abc">', validCss)
    ).toThrow("Template contains external URLs");
  });

  it("throws on </style> in css", () => {
    expect(() =>
      validateTemplate(validHtml, ".x { } </style> <script>")
    ).toThrow("Template CSS contains </style> sequences");
  });

  it("throws on @import in css", () => {
    expect(() =>
      validateTemplate(validHtml, "@import url('other.css'); .x{}")
    ).toThrow("Template CSS contains @import rules");
  });

  it("accepts valid html and css", () => {
    const result = validateTemplate(validHtml, validCss);
    expect(result).toEqual({ assetIds: new Set() });
  });
});
