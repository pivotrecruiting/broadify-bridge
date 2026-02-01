import { Card } from "@/components/card";
import type {
  NetworkConfigT,
  NetworkBindingOptionT,
  BridgeStatus,
} from "@broadify/protocol";
import { NetworkInterfaceSelector } from "./NetworkInterfaceSelector";
import { PortSelector } from "./PortSelector";
import { getPortConfig } from "../utils/network-utils";

interface NetworkSectionProps {
  networkConfig: NetworkConfigT | null;
  networkBindingOptions: NetworkBindingOptionT[];
  networkBindingId: string;
  networkPort: string;
  customPort: string;
  showAdvanced: boolean;
  portAvailability: Map<number, boolean>;
  checkingPorts: boolean;
  bridgeStatus: BridgeStatus;
  onBindingChange: (value: string) => void;
  onPortChange: (port: string) => void;
  onCustomPortChange: (port: string) => void;
  onToggleAdvanced: () => void;
  getCurrentPortConfig: () => ReturnType<typeof getPortConfig>;
}

/**
 * Network section component with interface and port selection
 */
export function NetworkSection({
  networkConfig,
  networkBindingOptions,
  networkBindingId,
  networkPort,
  customPort,
  showAdvanced,
  portAvailability,
  checkingPorts,
  bridgeStatus,
  onBindingChange,
  onPortChange,
  onCustomPortChange,
  onToggleAdvanced,
  getCurrentPortConfig,
}: NetworkSectionProps) {
  const portConfig = getCurrentPortConfig();
  const isAllInterfaces = networkBindingId === "all";
  const showToggle =
    networkConfig?.port.allowCustom &&
    networkConfig.port.customAdvancedOnly &&
    !portConfig?.customOnly;

  return (
    <Card variant="frosted" className="p-4 sm:p-5 md:p-6" gradient>
      <div className="grid grid-cols-1 md:grid-cols-[100px_1fr] lg:grid-cols-[120px_1fr] gap-4 md:gap-6 items-center">
        <h2 className="text-card-foreground font-bold text-base sm:text-lg md:text-lg">
          Network
        </h2>
        <div className="space-y-3 sm:space-y-4">
          <div className="flex items-center gap-2 sm:gap-3">
            <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap w-[60px] sm:w-[70px]">
              Interface
            </label>
            <NetworkInterfaceSelector
              value={networkBindingId}
              options={networkBindingOptions}
              onChange={onBindingChange}
              disabled={bridgeStatus.running}
            />
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap w-[60px] sm:w-[70px]">
              Port
            </label>
            <PortSelector
              portConfig={portConfig}
              networkPort={networkPort}
              customPort={customPort}
              showAdvanced={showAdvanced}
              portAvailability={portAvailability}
              checkingPorts={checkingPorts}
              networkConfig={networkConfig}
              onPortChange={onPortChange}
              onCustomPortChange={onCustomPortChange}
              disabled={bridgeStatus.running}
            />
          </div>
          {showToggle && (
            <div className="flex items-center gap-2 sm:gap-3">
              <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap w-[60px] sm:w-[70px] opacity-0 pointer-events-none">
                {/* Invisible label for alignment */}
              </label>
              <button
                type="button"
                onClick={onToggleAdvanced}
                className={`text-xs underline ${
                  isAllInterfaces
                    ? "text-card-foreground/30 cursor-not-allowed"
                    : "text-card-foreground/60 hover:text-card-foreground/80"
                }`}
                disabled={bridgeStatus.running || isAllInterfaces}
              >
                {showAdvanced ? "Default Ports" : "Custom Port"}
              </button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
