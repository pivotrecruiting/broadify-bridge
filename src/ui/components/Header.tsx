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
    <>
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
      <div className="flex justify-center mb-2 sm:mb-2 md:mb-3">
        <WebAppLink bridgeStatus={bridgeStatus} />
      </div>
    </>
  );
}

/**
 * Web-App Link Component
 * Renders a button to open the web app with bridgeId query parameter in the default browser
 */
function WebAppLink({ bridgeStatus }: { bridgeStatus: BridgeStatus }) {
  // Show link if bridge is running and webAppUrl is available
  // Don't require reachable=true, as bridge might still be starting
  if (!bridgeStatus.running || !bridgeStatus.webAppUrl) {
    return null;
  }

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (window.electron && bridgeStatus.webAppUrl) {
      try {
        await window.electron.openExternal(bridgeStatus.webAppUrl);
      } catch (error) {
        console.error("Failed to open web app URL:", error);
      }
    }
  };

  return (
    <button
      onClick={handleClick}
      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary hover:bg-primary/90 rounded-md transition-colors"
    >
      <span>Web-App öffnen</span>
      <svg
        className="w-4 h-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
        />
      </svg>
    </button>
  );
}
