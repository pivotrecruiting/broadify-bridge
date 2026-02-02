import type { BridgeStatus } from "@broadify/protocol";

interface StatusIndicatorProps {
  status: BridgeStatus;
}

/**
 * Status indicator component showing bridge status with colored dot and text
 */
export function StatusIndicator({ status }: StatusIndicatorProps) {
  return (
    <div className="flex items-center gap-2">
      <div
        className={`w-3 h-3 rounded-full ${
          status.running && status.reachable
            ? "bg-green-500"
            : status.running
            ? "bg-yellow-500"
            : "bg-destructive"
        }`}
      />
      <span className="text-card-foreground text-xs sm:text-sm font-semibold">
        {status.running && status.reachable
          ? "Running"
          : status.running
          ? "Starting..."
          : "Stopped"}
      </span>
    </div>
  );
}

