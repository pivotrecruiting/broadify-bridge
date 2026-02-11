export type GraphicsErrorCodeT =
  | "output_config_error"
  | "renderer_error"
  | "output_helper_error"
  | "graphics_error";

export class GraphicsError extends Error {
  code: GraphicsErrorCodeT;

  constructor(code: GraphicsErrorCodeT, message: string) {
    super(message);
    this.name = "GraphicsError";
    this.code = code;
  }
}
