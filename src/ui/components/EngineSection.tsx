import { useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { Card } from "@/components/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { EngineStateT } from "@broadify/protocol";
import {
  ENGINE_IP_PLACEHOLDERS,
  ENGINE_PORT_OPTIONS,
  ENGINE_TYPE_OPTIONS,
  type DesktopEngineTypeT,
} from "../constants/engine-constants";

interface EngineSectionProps {
  engineType: DesktopEngineTypeT;
  enginePort: string;
  engineIp: string;
  engineState: EngineStateT;
  loading: boolean;
  error: string | null;
  browserInputUrl?: string | null;
  recommendedInputName?: string | null;
  onTypeChange: (value: DesktopEngineTypeT) => void;
  onPortChange: (value: string) => void;
  onIpChange: (value: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

/**
 * Engine section component with engine type, IP, port selection, and connection controls.
 */
export function EngineSection({
  engineType,
  enginePort,
  engineIp,
  engineState,
  loading,
  error,
  browserInputUrl,
  recommendedInputName,
  onTypeChange,
  onPortChange,
  onIpChange,
  onConnect,
  onDisconnect,
}: EngineSectionProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const isConnected = engineState.status === "connected";
  const isConnecting = engineState.status === "connecting";
  const isDisconnected = engineState.status === "disconnected";
  const showBrowserInputHint =
    engineType === "vmix" && typeof browserInputUrl === "string";

  const copyToClipboard = async (value: string, field: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      setCopiedField(null);
    }
  };

  const getStatusColor = () => {
    switch (engineState.status) {
      case "connected":
        return "text-green-500";
      case "connecting":
        return "text-yellow-500";
      case "error":
        return "text-red-500";
      default:
        return "text-card-foreground/60";
    }
  };

  const getStatusText = () => {
    switch (engineState.status) {
      case "connected":
        return "Connected";
      case "connecting":
        return "Connecting...";
      case "disconnected":
        return "Disconnected";
      case "error":
        return `Error: ${engineState.error || "Unknown error"}`;
      default:
        return "Unknown";
    }
  };

  return (
    <Card variant="frosted" className="p-4 sm:p-5 md:p-6" gradient>
      <div className="grid grid-cols-1 md:grid-cols-[100px_1fr] lg:grid-cols-[120px_1fr] gap-4 md:gap-6">
        <h2 className="text-card-foreground font-bold text-base sm:text-lg md:text-lg">
          Engine
        </h2>
        <div className="space-y-3 sm:space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
            <div className="flex items-center gap-2 sm:gap-3">
              <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px]">
                Type
              </label>
              <Select
                value={engineType}
                onValueChange={(value) => onTypeChange(value as DesktopEngineTypeT)}
                disabled={isConnected}
              >
                <SelectTrigger className="w-full sm:w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENGINE_TYPE_OPTIONS.map((engineOption) => (
                    <SelectItem key={engineOption.value} value={engineOption.value}>
                      {engineOption.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px]">
                IP
              </label>
              <Input
                type="text"
                placeholder={ENGINE_IP_PLACEHOLDERS[engineType]}
                value={engineIp}
                onChange={(e) => onIpChange(e.target.value)}
                disabled={isConnected}
                className="w-full sm:w-32 border border-card-foreground/15 bg-white/20 hover:bg-white/25 active:bg-white/30 text-card-foreground font-medium placeholder:text-card-foreground/60 focus-visible:ring-card-foreground/30 focus-visible:border-card-foreground/30 shadow-lg shadow-card-foreground/15 hover:shadow-xl hover:shadow-card-foreground/20 focus-visible:shadow-xl focus-visible:shadow-card-foreground/25 transition-all h-9 px-3 py-2 text-sm"
              />
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px]">
                Port
              </label>
              <Select value={enginePort} onValueChange={onPortChange} disabled={isConnected}>
                <SelectTrigger className="w-full sm:w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENGINE_PORT_OPTIONS.map((port) => (
                    <SelectItem key={port} value={port}>
                      {port}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center gap-3 sm:gap-4">
            {isConnected ? (
              <Button
                onClick={onDisconnect}
                disabled={loading}
                className="bg-destructive hover:bg-destructive/90 text-white font-semibold px-4 py-2 text-sm rounded-lg border border-red-500/20 shadow-lg"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Disconnecting...
                  </>
                ) : (
                  "Disconnect"
                )}
              </Button>
            ) : (
              <Button
                onClick={onConnect}
                disabled={loading || !engineIp || isConnecting}
                className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold px-4 py-2 text-sm rounded-lg border border-primary/20 shadow-lg"
              >
                {loading || isConnecting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  "Connect"
                )}
              </Button>
            )}
            <div className="flex items-center gap-2">
              <div className={`h-2 w-2 rounded-full ${getStatusColor()} ${isConnected ? "bg-green-500" : isConnecting ? "bg-yellow-500" : isDisconnected ? "bg-gray-400" : "bg-red-500"}`} />
              <span className={`text-xs sm:text-sm font-medium ${getStatusColor()}`}>
                {getStatusText()}
              </span>
            </div>
          </div>
          {error && (
            <div className="text-red-500 text-xs sm:text-sm">
              {error}
            </div>
          )}

          {showBrowserInputHint ? (
            <div className="rounded-xl border border-card-foreground/10 bg-white/10 p-3 space-y-3">
              <div className="space-y-1">
                <div className="text-sm font-semibold text-card-foreground">
                  vMix Browser Input
                </div>
                <p className="text-xs text-card-foreground/70 leading-relaxed">
                  Same-machine flow: create a vMix Browser Input and use the local
                  bridge URL below. This desktop hint does not change the bridge
                  graphics mode by itself.
                </p>
              </div>

              <div className="space-y-1">
                <span className="text-[11px] uppercase tracking-[0.16em] text-card-foreground/60">
                  Browser Input URL
                </span>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 break-all rounded-md bg-black/15 px-3 py-2 font-mono text-xs text-card-foreground/85">
                    {browserInputUrl}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => copyToClipboard(browserInputUrl, "browser-input-url")}
                    aria-label="Copy browser input URL"
                    className="bg-transparent text-muted-foreground hover:text-foreground hover:bg-white/10"
                  >
                    {copiedField === "browser-input-url" ? (
                      <Check className="copy-check-animate" />
                    ) : (
                      <Copy />
                    )}
                  </Button>
                </div>
              </div>

              <div className="space-y-1">
                <span className="text-[11px] uppercase tracking-[0.16em] text-card-foreground/60">
                  Recommended Input Name
                </span>
                <div className="text-xs text-card-foreground/85">
                  {recommendedInputName || "Broadify Browser Input"}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
