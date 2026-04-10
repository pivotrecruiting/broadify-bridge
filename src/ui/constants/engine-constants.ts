export type DesktopEngineTypeT = "atem" | "vmix";

export const ENGINE_TYPE_OPTIONS: Array<{
  value: DesktopEngineTypeT;
  label: string;
}> = [
  { value: "atem", label: "ATEM" },
  { value: "vmix", label: "vMix" },
] as const;

/**
 * Engine port options
 */
export const ENGINE_PORT_OPTIONS = ["8088", "9091", "9910", "8080", "8000"] as const;

export const ENGINE_DEFAULT_PORTS: Record<DesktopEngineTypeT, string> = {
  atem: "9910",
  vmix: "8088",
};

export const ENGINE_IP_PLACEHOLDERS: Record<DesktopEngineTypeT, string> = {
  atem: "192.168.1.1",
  vmix: "127.0.0.1",
};
