import { Settings } from "lucide-react";
import type { BridgeStatus } from "types";
import { StatusIndicator } from "./StatusIndicator";
import logo from "../assets/logo.svg";

interface HeaderProps {
  bridgeStatus: BridgeStatus;
}

/**
 * Header component with logo, settings button, and status indicator
 */
export function Header({ bridgeStatus }: HeaderProps) {
  return (
    <div className="flex items-center justify-between mb-2 sm:mb-2 md:mb-3">
      <div className="flex items-center justify-start w-[100px] sm:w-[120px]">
        <button className="text-card-foreground hover:text-card-foreground/80 transition-colors">
          <Settings className="w-5 h-5 sm:w-6 sm:h-6" />
        </button>
      </div>
      <div className="flex-1 flex justify-center">
        <img src={logo} alt="broadify" className="h-14 sm:h-16 md:h-20" />
      </div>
      <div className="flex items-center justify-end gap-2 w-[100px] sm:w-[120px]">
        <StatusIndicator status={bridgeStatus} />
      </div>
    </div>
  );
}

