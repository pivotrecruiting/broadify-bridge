import { useState } from "react";
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
}: BridgeIdentitySectionProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const copyToClipboard = async (value: string, field: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1200);
    } catch {
      setCopiedField(null);
    }
  };

  const expiresLabel = pairingExpiresAt
    ? new Date(pairingExpiresAt).toLocaleTimeString()
    : null;

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
              {bridgeName || "Nicht gesetzt"}
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
                  variant="outline"
                  size="sm"
                  onClick={() => copyToClipboard(bridgeId, "id")}
                >
                  {copiedField === "id" ? "Kopiert" : "Kopieren"}
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Pairing-Code</span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-mono text-card-foreground">
                {isRunning ? pairingCode || "—" : "-"}
              </span>
              {isRunning && pairingCode && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => copyToClipboard(pairingCode, "pairing")}
                >
                  {copiedField === "pairing" ? "Kopiert" : "Kopieren"}
                </Button>
              )}
              {pairingExpired && (
                <span className="text-xs text-red-400">
                  Abgelaufen{expiresLabel ? ` (${expiresLabel})` : ""}
                </span>
              )}
              {!pairingExpired && expiresLabel && (
                <span className="text-xs text-muted-foreground">
                  Gültig bis {expiresLabel}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
