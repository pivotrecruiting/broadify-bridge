import { ExternalLink } from "lucide-react";
import type { BridgeStatus } from "types";

interface TunnelLinkProps {
  bridgeStatus: BridgeStatus;
}

/**
 * Tunnel Link component that displays a clickable link to the Cloudflare Tunnel URL
 * Only shown in Production when tunnel is running and tunnelUrl is available
 * In Development, tunnelRunning and tunnelUrl are not set, so this component won't render
 */
export function TunnelLink({ bridgeStatus }: TunnelLinkProps) {
  if (!bridgeStatus.tunnelRunning || !bridgeStatus.tunnelUrl) {
    return null;
  }

  const handleClick = async () => {
    if (window.electron && bridgeStatus.tunnelUrl) {
      try {
        await window.electron.openExternal(bridgeStatus.tunnelUrl);
      } catch (error) {
        console.error("[TunnelLink] Error opening external URL:", error);
        // Fallback: open in browser
        if (bridgeStatus.tunnelUrl) {
          window.open(bridgeStatus.tunnelUrl, "_blank");
        }
      }
    } else if (bridgeStatus.tunnelUrl) {
      // Fallback: open in browser
      window.open(bridgeStatus.tunnelUrl, "_blank");
    }
  };

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-2 text-sm text-card-foreground hover:text-card-foreground/80 transition-colors underline"
    >
      <ExternalLink className="w-4 h-4" />
      <span>Tunnel: {bridgeStatus.tunnelUrl}</span>
    </button>
  );
}
