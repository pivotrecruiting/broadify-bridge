import { useEffect, useState } from "react";
import { X, RefreshCw, Clipboard, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type LogScope = "bridge" | "app";

interface LogsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LogsDialog({ isOpen, onClose }: LogsDialogProps) {
  const [scope, setScope] = useState<LogScope>("bridge");
  const [lines, setLines] = useState("500");
  const [filter, setFilter] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLogs = async () => {
    if (!window.electron) {
      setError("Electron API not available");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const parsedLines = parseInt(lines, 10);
      const options = {
        lines: Number.isFinite(parsedLines) ? parsedLines : 500,
        filter: filter.trim() ? filter.trim() : undefined,
      };

      const result =
        scope === "bridge"
          ? await window.electron.bridgeGetLogs(options)
          : await window.electron.appGetLogs(options);

      if (result.error) {
        setError(result.error);
        setContent("");
      } else {
        setContent(result.content || "");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch logs";
      setError(message);
      setContent("");
    } finally {
      setLoading(false);
    }
  };

  const clearLogs = async () => {
    if (!window.electron) {
      setError("Electron API not available");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result =
        scope === "bridge"
          ? await window.electron.bridgeClearLogs()
          : await window.electron.appClearLogs();
      if (result.error) {
        setError(result.error);
      } else {
        setContent("");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to clear logs";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    fetchLogs();
  }, [isOpen, scope]);

  const handleCopy = async () => {
    if (!content) return;
    await navigator.clipboard.writeText(content);
  };

  if (!isOpen) return null;

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

      <div className="relative w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-lg glass-frosted border border-white/20 shadow-2xl">
        <div className="flex items-center justify-between p-6 border-b border-white/10">
          <div>
            <h2 className="text-2xl font-bold text-foreground">Diagnostics</h2>
            <p className="text-sm text-muted-foreground">
              Bridge- und App-Logs direkt aus der Tray-App
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-md hover:bg-white/10 transition-colors text-foreground hover:text-foreground/80"
            aria-label="Schließen"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="inline-flex rounded-md border border-white/10 overflow-hidden">
              <button
                className={`px-3 py-2 text-sm ${
                  scope === "bridge"
                    ? "bg-primary text-white"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setScope("bridge")}
              >
                Bridge Logs
              </button>
              <button
                className={`px-3 py-2 text-sm ${
                  scope === "app"
                    ? "bg-primary text-white"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setScope("app")}
              >
                App Logs
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              <Input
                className="w-32"
                value={lines}
                onChange={(e) => setLines(e.target.value)}
                placeholder="Lines"
              />
              <Input
                className="w-48"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter (z.B. Outputs)"
              />
              <Button
                variant="secondary"
                onClick={fetchLogs}
                disabled={loading}
              >
                <RefreshCw className="w-4 h-4" />
                Refresh
              </Button>
              <Button
                variant="destructive"
                onClick={clearLogs}
                disabled={loading}
              >
                <Trash2 className="w-4 h-4" />
                Clear
              </Button>
              <Button
                variant="outline"
                onClick={handleCopy}
                disabled={!content}
              >
                <Clipboard className="w-4 h-4" />
                Copy
              </Button>
            </div>
          </div>

          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-md p-3">
              {error}
            </div>
          )}

          <div className="border border-white/10 rounded-md bg-black/40 h-[50vh] overflow-auto p-3">
            <pre className="text-xs text-slate-200 whitespace-pre-wrap break-words font-mono">
              {loading ? "Loading..." : content || "No logs available."}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
