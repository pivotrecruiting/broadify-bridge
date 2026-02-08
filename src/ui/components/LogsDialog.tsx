import { useEffect, useState } from "react";
import { X, RefreshCw, Copy, Check, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
  const [copied, setCopied] = useState(false);

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
      const message =
        err instanceof Error ? err.message : "Failed to fetch logs";
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
      const message =
        err instanceof Error ? err.message : "Failed to clear logs";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    fetchLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, scope]);

  const handleCopy = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
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
      <div className="fixed inset-0 bg-white/55 backdrop-blur-sm" />

      <div className="relative w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-lg glass-frosted border border-white/20 shadow-2xl">
        <div className="flex items-center justify-between p-6 border-b border-white/10">
          <div>
            <h2 className="text-2xl font-bold text-foreground">Diagnostics</h2>
            <p className="text-sm text-muted-foreground">
              Bridge and app logs directly from the tray app
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
          <div className="flex flex-wrap gap-2">
            <Input
              className="w-28"
              value={lines}
              onChange={(e) => setLines(e.target.value)}
              placeholder="Lines"
            />
            <Input
              className="w-48"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter (e.g. Outputs)"
            />
          </div>
          <Tabs
            value={scope}
            onValueChange={(value: string) => setScope(value as LogScope)}
          >
            <div className="flex items-center justify-between gap-3">
              <TabsList className="bg-white border w-fit justify-start p-0 gap-0">
                <TabsTrigger 
                  value="bridge" 
                  className="px-4 py-1.5 text-center data-[state=active]:bg-primary/30 border-r border-border rounded-none first:rounded-l-md last:rounded-r-md"
                >
                  Bridge Logs
                </TabsTrigger>
                <TabsTrigger 
                  value="app" 
                  className="px-4 py-1.5 text-center data-[state=active]:bg-primary/30 border-r border-border rounded-none first:rounded-l-md last:rounded-r-md last:border-r-0"
                >
                  App Logs
                </TabsTrigger>
              </TabsList>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={handleCopy}
                  disabled={!content}
                  aria-label="Copy logs"
                  className="gap-2"
                >
                  {copied ? (
                    <Check className="copy-check-animate" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                  Copy Logs
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={fetchLogs}
                  disabled={loading}
                  aria-label="Refresh logs"
                  className="bg-transparent text-muted-foreground hover:text-foreground hover:bg-white/10"
                >
                  <RefreshCw className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={clearLogs}
                  disabled={loading}
                  aria-label="Clear logs"
                  className="bg-transparent text-muted-foreground hover:text-foreground hover:bg-white/10"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {error && (
              <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-md p-3 mt-3">
                {error}
              </div>
            )}

            <TabsContent value="bridge">
              <div className="border border-black/10 rounded-md bg-white/60 h-[50vh] overflow-auto p-3">
                <pre className="text-xs text-slate-800 whitespace-pre-wrap break-words font-mono">
                  {loading ? "Loading..." : content || "No logs available."}
                </pre>
              </div>
            </TabsContent>

            <TabsContent value="app">
              <div className="border border-black/10 rounded-md bg-white/60 h-[50vh] overflow-auto p-3">
                <pre className="text-xs text-slate-800 whitespace-pre-wrap break-words font-mono">
                  {loading ? "Loading..." : content || "No logs available."}
                </pre>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
