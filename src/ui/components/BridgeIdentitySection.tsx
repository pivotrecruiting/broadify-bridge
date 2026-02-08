import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Card } from "@/components/card";
import { Button } from "@/components/ui/button";

interface BridgeIdentitySectionProps {
  bridgeId?: string;
  bridgeName?: string | null;
  appVersion?: string;
  pairingCode?: string;
  pairingExpiresAt?: string;
  pairingExpired?: boolean;
  isRunning: boolean;
  onOpenPairing: () => void;
}

/**
 * Displays bridge identity details and pairing code for WebApp linking.
 */
export function BridgeIdentitySection({
  bridgeId,
  bridgeName,
  appVersion,
  pairingCode,
  pairingExpiresAt,
  pairingExpired,
  isRunning,
  onOpenPairing,
}: BridgeIdentitySectionProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const copyToClipboard = async (value: string, field: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      setCopiedField(null);
    }
  };

  const expiresLabel = pairingExpiresAt
    ? new Date(pairingExpiresAt).toLocaleTimeString()
    : null;
  const hasPairingCode = Boolean(pairingCode) && isRunning;
  const pairingStatus = !isRunning
    ? "Not available"
    : pairingExpired
    ? `Expired${expiresLabel ? ` (${expiresLabel})` : ""}`
    : expiresLabel
    ? `Valid until ${expiresLabel}`
    : hasPairingCode
    ? "Available"
    : "";

  return (
    <Card variant="frosted" className="p-4 sm:p-5 md:p-6" gradient>
      <div className="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-4 md:gap-6 items-start">
        <div className="space-y-1">
          <h2 className="text-card-foreground font-bold text-base sm:text-lg md:text-lg">
            Bridge
          </h2>
          <span className="text-xs text-muted-foreground">
            Version {appVersion || "—"}
          </span>
        </div>
        <div className="space-y-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Name</span>
            <div className="text-sm font-medium text-card-foreground">
              {bridgeName || "Not set"}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Bridge ID</span>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-card-foreground/80">
                {bridgeId || "—"}
              </span>
              {bridgeId && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => copyToClipboard(bridgeId, "id")}
                  aria-label="Copy bridge ID"
                  className="bg-transparent text-muted-foreground hover:text-foreground hover:bg-white/10"
                >
                  {copiedField === "id" ? (
                    <Check className="copy-check-animate" />
                  ) : (
                    <Copy />
                  )}
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={onOpenPairing}
                disabled={!hasPairingCode}
              >
                Pairing
              </Button>
              <span
                className={`text-xs ${
                  pairingExpired ? "text-red-400" : "text-muted-foreground"
                }`}
              >
                {pairingStatus}
              </span>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
