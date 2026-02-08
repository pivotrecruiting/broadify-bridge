import { useEffect, useState } from "react";
import { X, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PairingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  pairingCode?: string;
  pairingExpiresAt?: string;
  pairingExpired?: boolean;
  isRunning: boolean;
}

/**
 * Pairing dialog that reveals the pairing code on demand.
 */
export function PairingDialog({
  isOpen,
  onClose,
  pairingCode,
  pairingExpiresAt,
  pairingExpired,
  isRunning,
}: PairingDialogProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const expiresLabel = pairingExpiresAt
    ? new Date(pairingExpiresAt).toLocaleTimeString()
    : null;
  const hasPairingCode = Boolean(pairingCode) && isRunning;
  const statusLabel = !isRunning
    ? "Bridge is not running."
    : pairingExpired
    ? `Expired${expiresLabel ? ` (${expiresLabel})` : ""}`
    : expiresLabel
    ? `Valid until ${expiresLabel}`
    : "Active";

  const handleCopy = async () => {
    if (!pairingCode) return;
    try {
      await navigator.clipboard.writeText(pairingCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" />

      <div className="relative w-full max-w-lg overflow-hidden rounded-lg glass-frosted border border-white/20 shadow-2xl">
        <div className="flex items-center justify-between p-6 border-b border-white/10">
          <div>
            <h2 className="text-2xl font-bold text-foreground">Pairing</h2>
            <p className="text-sm text-muted-foreground">
              Reveal and copy the code to connect the web app.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-md hover:bg-white/10 transition-colors text-foreground hover:text-foreground/80"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="rounded-md border border-white/10 bg-black/30 p-4">
            {hasPairingCode ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-lg font-mono text-card-foreground">
                  {pairingCode}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleCopy}
                  aria-label="Copy pairing code"
                  className="bg-transparent text-muted-foreground hover:text-foreground hover:bg-white/10"
                >
                  {copied ? (
                    <Check className="copy-check-animate" />
                  ) : (
                    <Copy />
                  )}
                </Button>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                Pairing code is not available. Start the bridge to generate one.
              </div>
            )}
          </div>

          <div
            className={`text-xs ${
              pairingExpired ? "text-red-400" : "text-muted-foreground"
            }`}
          >
            {statusLabel}
          </div>
        </div>
      </div>
    </div>
  );
}
