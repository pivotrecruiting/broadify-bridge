import { Card } from "@/components/card";
import { Button } from "@/components/ui/button";
import { Loader2, Play, Square } from "lucide-react";
import type { MacroT } from "@broadify/protocol";

interface MacroListProps {
  macros: MacroT[];
  loading: boolean;
  error: string | null;
  onRunMacro: (macroId: number) => void;
  onStopMacro: (macroId: number) => void;
}

/**
 * Macro list component that displays all macros with run/stop buttons
 */
export function MacroList({
  macros,
  loading,
  error,
  onRunMacro,
  onStopMacro,
}: MacroListProps) {
  if (error) {
    return (
      <Card variant="frosted" className="p-4 sm:p-5 md:p-6" gradient>
        <div className="text-red-500 text-sm">{error}</div>
      </Card>
    );
  }

  if (macros.length === 0) {
    return (
      <Card variant="frosted" className="p-4 sm:p-5 md:p-6" gradient>
        <div className="text-card-foreground/60 text-sm">
          No macros available
        </div>
      </Card>
    );
  }

  const getStatusColor = (status: MacroT["status"]) => {
    switch (status) {
      case "running":
        return "text-green-500";
      case "recording":
        return "text-yellow-500";
      default:
        return "text-card-foreground/60";
    }
  };

  const getStatusText = (status: MacroT["status"]) => {
    switch (status) {
      case "running":
        return "Running";
      case "recording":
        return "Recording";
      default:
        return "Idle";
    }
  };

  return (
    <Card variant="frosted" className="p-4 sm:p-5 md:p-6" gradient>
      <div className="space-y-3">
        <h3 className="text-card-foreground font-bold text-base sm:text-lg">
          Macros
        </h3>
        {loading && macros.length === 0 ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-6 w-6 animate-spin text-card-foreground/60" />
          </div>
        ) : (
          <div className="space-y-2">
            {macros.map((macro) => (
              <div
                key={macro.id}
                className="flex items-center justify-between gap-3 p-3 rounded-lg bg-white/10 border border-card-foreground/10"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-card-foreground font-medium text-sm sm:text-base truncate">
                      {macro.name || `Macro ${macro.id + 1}`}
                    </span>
                    <span className={`text-xs font-medium ${getStatusColor(macro.status)}`}>
                      ({getStatusText(macro.status)})
                    </span>
                  </div>
                  <div className="text-card-foreground/60 text-xs mt-1">
                    ID: {macro.id}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {macro.status === "running" || macro.status === "recording" ? (
                    <Button
                      onClick={() => onStopMacro(macro.id)}
                      disabled={loading}
                      size="sm"
                      className="bg-destructive hover:bg-destructive/90 text-white font-semibold px-3 py-1.5 text-xs rounded-lg border border-red-500/20 shadow-lg"
                    >
                      {loading ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <>
                          <Square className="h-3 w-3 mr-1" />
                          Stop
                        </>
                      )}
                    </Button>
                  ) : (
                    <Button
                      onClick={() => onRunMacro(macro.id)}
                      disabled={loading}
                      size="sm"
                      className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold px-3 py-1.5 text-xs rounded-lg border border-primary/20 shadow-lg"
                    >
                      {loading ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <>
                          <Play className="h-3 w-3 mr-1" />
                          Run
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

