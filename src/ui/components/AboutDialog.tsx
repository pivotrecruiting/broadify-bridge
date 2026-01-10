import { X, ExternalLink } from "lucide-react";
import { useEffect } from "react";

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * About Dialog Component
 * Displays application information, version, and license notices
 */
export function AboutDialog({ isOpen, onClose }: AboutDialogProps) {
  // Close on Escape key
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => {
        // Close when clicking backdrop
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" />

      {/* Dialog */}
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-hidden rounded-lg glass-frosted border border-white/20 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-white/10">
          <h2 className="text-2xl font-bold text-foreground">
            Über Broadify Bridge
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-md hover:bg-white/10 transition-colors text-foreground hover:text-foreground/80"
            aria-label="Schließen"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto max-h-[calc(90vh-140px)] p-6 space-y-6">
          {/* Version Info */}
          <div>
            <h3 className="text-lg font-semibold text-foreground mb-2">
              Version
            </h3>
            <p className="text-muted-foreground">0.1.22</p>
          </div>

          {/* License Information */}
          <div>
            <h3 className="text-lg font-semibold text-foreground mb-3">
              Lizenzinformationen
            </h3>
            <div className="space-y-4 text-sm text-muted-foreground">
              <div className="pt-3 border-t border-white/10">
                <h4 className="font-medium text-foreground mb-1">Electron</h4>
                <p>Diese Anwendung wurde mit Electron erstellt.</p>
                <p className="mt-1">
                  <strong>Lizenz:</strong> MIT
                </p>
                <p className="mt-1">
                  <strong>Website:</strong>{" "}
                  <a
                    href="https://www.electronjs.org/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    https://www.electronjs.org/
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </p>
              </div>

              <div className="pt-3 border-t border-white/10">
                <h4 className="font-medium text-foreground mb-1">React</h4>
                <p>
                  Diese Anwendung verwendet React für die Benutzeroberfläche.
                </p>
                <p className="mt-1">
                  <strong>Lizenz:</strong> MIT
                </p>
                <p className="mt-1">
                  <strong>Website:</strong>{" "}
                  <a
                    href="https://react.dev/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    https://react.dev/
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </p>
              </div>
            </div>
          </div>

          {/* Additional Information */}
          <div>
            <h3 className="text-lg font-semibold text-foreground mb-3">
              Weitere Informationen
            </h3>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                Alle npm-Abhängigkeiten sind in{" "}
                <code className="bg-white/10 px-1 rounded">package.json</code>{" "}
                aufgelistet. Die meisten Abhängigkeiten verwenden permissive
                Lizenzen (MIT, Apache-2.0, BSD-2-Clause, ISC).
              </p>
              <p>
                Für eine vollständige Liste der Abhängigkeiten und ihrer
                Lizenzen, siehe{" "}
                <code className="bg-white/10 px-1 rounded">NOTICES.md</code> und{" "}
                <code className="bg-white/10 px-1 rounded">LICENSE</code>.
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end p-6 border-t border-white/10">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-foreground bg-primary hover:bg-primary/90 rounded-md transition-colors"
          >
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}
