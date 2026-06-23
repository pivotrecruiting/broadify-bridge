import { Button } from "@/components/ui/button";
import type { BridgeStatus } from "@broadify/protocol";

interface BridgeControlButtonProps {
  bridgeStatus: BridgeStatus;
  isStarting: boolean;
  isStopping: boolean;
  onStart: () => void;
  onStop: () => void;
  disabled?: boolean;
}

/**
 * Bridge control button component that shows either start or stop button
 */
export function BridgeControlButton({
  bridgeStatus,
  isStarting,
  isStopping,
  onStart,
  onStop,
  disabled,
}: BridgeControlButtonProps) {
  return (
    <div className="p-4 sm:p-5 md:p-6">
      <div className="flex justify-center">
        {!bridgeStatus.running ? (
          <Button
            variant="cta"
            className="font-bold px-8 sm:px-16 md:px-20 py-3 sm:py-3.5 md:py-4 h-auto text-sm sm:text-base w-full sm:w-auto"
            onClick={onStart}
            disabled={disabled || isStarting}
          >
            {isStarting ? "Starting..." : "Launch GUI"}
          </Button>
        ) : (
          <Button
            variant="destructive"
            className="font-bold px-8 sm:px-16 md:px-20 py-3 sm:py-3.5 md:py-4 h-auto text-sm sm:text-base w-full sm:w-auto"
            onClick={onStop}
            disabled={isStopping}
          >
            {isStopping ? "Stopping..." : "Stop Server"}
          </Button>
        )}
      </div>
    </div>
  );
}

