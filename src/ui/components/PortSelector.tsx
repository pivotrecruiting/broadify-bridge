import { Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import type { NetworkConfigT, InterfacePortConfigT } from "types";
import { shouldUseCustomPort } from "../utils/port-utils";

interface PortSelectorProps {
  portConfig: InterfacePortConfigT | undefined;
  networkPort: string;
  customPort: string;
  showAdvanced: boolean;
  portAvailability: Map<number, boolean>;
  checkingPorts: boolean;
  networkConfig: NetworkConfigT | null;
  onPortChange: (port: string) => void;
  onCustomPortChange: (port: string) => void;
  disabled?: boolean;
}

/**
 * Port selector component that shows either a dropdown or input based on configuration
 */
export function PortSelector({
  portConfig,
  networkPort,
  customPort,
  showAdvanced,
  portAvailability,
  checkingPorts,
  networkConfig,
  onPortChange,
  onCustomPortChange,
  disabled,
}: PortSelectorProps) {
  const useCustomOnly =
    portConfig?.customOnly ||
    (showAdvanced && networkConfig?.port.customAdvancedOnly);

  return (
    <div className="flex items-center gap-2">
      {useCustomOnly ? (
        <Input
          type="number"
          placeholder="Custom Port"
          value={customPort}
          onChange={(e) => onCustomPortChange(e.target.value)}
          disabled={disabled}
          min={1}
          max={65535}
          className="w-full sm:w-24 border border-card-foreground/15 bg-white/20 hover:bg-white/25 active:bg-white/30 text-card-foreground font-medium placeholder:text-card-foreground/60 focus-visible:ring-card-foreground/30 focus-visible:border-card-foreground/30 shadow-lg shadow-card-foreground/15 hover:shadow-xl hover:shadow-card-foreground/20 focus-visible:shadow-xl focus-visible:shadow-card-foreground/25 transition-all h-9 px-3 py-2 text-sm"
        />
      ) : (
        <>
          <Select
            value={networkPort || undefined}
            onValueChange={onPortChange}
            disabled={disabled || checkingPorts}
          >
            <SelectTrigger className="w-full sm:w-24">
              <SelectValue placeholder="Select">
                {networkPort || ""}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {networkConfig &&
                [
                  networkConfig.port.default,
                  ...networkConfig.port.autoFallback,
                ].map((port) => {
                  const available = portAvailability.get(port);
                  const isSelected = networkPort === port.toString();
                  const isDisabled = available === false && !isSelected;
                  return (
                    <SelectItem
                      key={port}
                      value={port.toString()}
                      disabled={isDisabled}
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-2 h-2 rounded-full ${
                            available === true
                              ? "bg-green-500"
                              : available === false
                              ? "bg-red-500"
                              : "bg-gray-400"
                          }`}
                        />
                        <span>{port}</span>
                        {available === false && (
                          <span className="text-xs text-red-400">(belegt)</span>
                        )}
                      </div>
                    </SelectItem>
                  );
                })}
            </SelectContent>
          </Select>
          {checkingPorts && (
            <Loader2 className="w-4 h-4 text-card-foreground/60 animate-spin" />
          )}
          {!checkingPorts &&
            networkPort &&
            portAvailability.has(parseInt(networkPort, 10)) && (
              <div
                className={`w-2 h-2 rounded-full ${
                  portAvailability.get(parseInt(networkPort, 10))
                    ? "bg-green-500"
                    : "bg-red-500"
                }`}
                title={
                  portAvailability.get(parseInt(networkPort, 10))
                    ? "Port ist frei"
                    : "Port ist belegt"
                }
              />
            )}
        </>
      )}
    </div>
  );
}

