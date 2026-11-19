export type GraphicsErrorCodeT =
  | "output_config_error"
  | "renderer_error"
  | "output_helper_error"
  /** The configured display output port is not in the device cache (unplugged). */
  | "output_device_not_found"
  | "graphics_error";

export class GraphicsError extends Error {
  code: GraphicsErrorCodeT;

  constructor(code: GraphicsErrorCodeT, message: string) {
    super(message);
    this.name = "GraphicsError";
    this.code = code;
  }
}
