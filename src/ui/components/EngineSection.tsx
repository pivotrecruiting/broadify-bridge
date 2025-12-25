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
import { Loader2 } from "lucide-react";
import { ENGINE_ATEM_OPTIONS, ENGINE_PORT_OPTIONS } from "../constants/engine-constants";
import type { EngineStateT } from "types";

interface EngineSectionProps {
  engineAtem: string;
  enginePort: string;
  engineIp: string;
  engineState: EngineStateT;
  loading: boolean;
  error: string | null;
  onAtemChange: (value: string) => void;
  onPortChange: (value: string) => void;
  onIpChange: (value: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

/**
 * Engine section component with ATEM, IP, port selection, and connection controls
 */
export function EngineSection({
  engineAtem,
  enginePort,
  engineIp,
  engineState,
  loading,
  error,
  onAtemChange,
  onPortChange,
  onIpChange,
  onConnect,
  onDisconnect,
}: EngineSectionProps) {
  const isConnected = engineState.status === "connected";
  const isConnecting = engineState.status === "connecting";
  const isDisconnected = engineState.status === "disconnected";

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
              <Select value={engineAtem} onValueChange={onAtemChange} disabled={isConnected}>
                <SelectTrigger className="w-full sm:w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENGINE_ATEM_OPTIONS.map((atem) => (
                    <SelectItem key={atem} value={atem}>
                      {atem}
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
                placeholder="127.0.0.1"
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
        </div>
      </div>
    </Card>
  );
}

