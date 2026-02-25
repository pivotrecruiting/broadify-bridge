import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type OnboardingStep = "terms" | "name";

interface OnboardingDialogProps {
  isOpen: boolean;
  step: OnboardingStep;
  onTermsAccept: () => Promise<void>;
  onNameSave: (name: string) => Promise<{ success: boolean; error?: string }>;
  initialName?: string | null;
}

const URL_EULA_DESKTOP =
  "https://broadify.de/recht/software-nutzungsbedingungen-broadify-bridge";
const URL_PRIVACY_DESKTOP =
  "https://broadify.de/recht/datenschutzhinweise-broadify-bridge";
const URL_SECURITY_REMOTE =
  "https://broadify.de/recht/security-remote-control-broadify-bridge";
const URL_TECHNICAL_APPENDIX =
  "https://broadify.de/recht/technischer-anhang-broadify-bridge";

const TERMS_INTRO = `Mit der Nutzung der Broadify Bridge Desktop-App stimmen Sie den Software-Nutzungsbedingungen (EULA) sowie den Datenschutzhinweisen fuer Desktop-App, lokale Bridge und Relay zu.

Die App startet eine lokal laufende Bridge-Komponente und kann - je nach Nutzung - ueber die Broadify WebApp remote gesteuert werden. Dabei koennen Steuerungs-, Status- und Inhaltsdaten ueber einen Relay-Dienst verarbeitet werden.

Je nach Funktion verarbeitet die Software ausserdem lokale Netzwerk-, System- und Hardwaremetadaten (z. B. Netzwerkinterfaces, Ports, Displays oder angeschlossene Geraete) fuer Konfiguration, Betrieb und Diagnose.`;

/**
 * Multi-step onboarding dialog: first Terms/AGB (must accept), then Bridge name.
 * No way to dismiss without completing both steps when both are required.
 */
export function OnboardingDialog({
  isOpen,
  step,
  onTermsAccept,
  onNameSave,
  initialName,
}: OnboardingDialogProps) {
  const [termsChecked, setTermsChecked] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [name, setName] = useState(initialName || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName(initialName || "");
      setError(null);
      if (step === "terms") {
        setTermsChecked(false);
      }
    }
  }, [isOpen, initialName, step]);

  if (!isOpen) return null;

  const handleAcceptTerms = async () => {
    if (!termsChecked) return;
    setAccepting(true);
    setError(null);
    try {
      await onTermsAccept();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Acceptance failed. Please try again.",
      );
    } finally {
      setAccepting(false);
    }
  };

  const handleSaveName = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Please enter a bridge name.");
      return;
    }
    setSaving(true);
    setError(null);
    const result = await onNameSave(trimmed);
    if (!result.success) {
      setError(result.error || "Save failed");
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-white/55 backdrop-blur-sm" />

      <div className="relative w-full max-w-lg rounded-lg bg-white border border-white/20 shadow-2xl p-6 space-y-4">
        {/* Step indicator */}
        <div className="flex gap-2 text-sm text-muted-foreground">
          <span
            className={
              step === "terms"
                ? "font-semibold text-foreground"
                : "text-muted-foreground"
            }
          >
            1. Nutzungsbedingungen
          </span>
          <span aria-hidden>/</span>
          <span
            className={
              step === "name"
                ? "font-semibold text-foreground"
                : "text-muted-foreground"
            }
          >
            2. Bridge-Name
          </span>
        </div>

        {step === "terms" && (
          <>
            <div>
              <h2 className="text-xl font-bold text-foreground">
                Nutzungsbedingungen &amp; Datenschutz
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Bitte lesen und akzeptieren Sie die Bedingungen, um
                fortzufahren.
              </p>
            </div>

            <div
              className="max-h-48 overflow-y-auto rounded-md border border-border bg-muted/30 p-3 text-sm text-foreground whitespace-pre-wrap"
              role="document"
            >
              {TERMS_INTRO}
            </div>

            <p className="text-sm text-foreground">
              Lesen Sie die vollständigen Texte:{" "}
              <button
                type="button"
                className="text-primary underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-primary rounded"
                onClick={() => window.electron?.openExternal(URL_PRIVACY_DESKTOP)}
              >
                Datenschutz (App &amp; Relay)
              </button>
              {" · "}
              <button
                type="button"
                className="text-primary underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-primary rounded"
                onClick={() => window.electron?.openExternal(URL_EULA_DESKTOP)}
              >
                EULA
              </button>
              {" · "}
              <button
                type="button"
                className="text-primary underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-primary rounded"
                onClick={() => window.electron?.openExternal(URL_SECURITY_REMOTE)}
              >
                Security/Remote-Control
              </button>
              {" · "}
              <button
                type="button"
                className="text-primary underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-primary rounded"
                onClick={() =>
                  window.electron?.openExternal(URL_TECHNICAL_APPENDIX)
                }
              >
                Technischer Anhang
              </button>
            </p>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={termsChecked}
                onChange={(e) => setTermsChecked(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-input accent-primary"
                aria-describedby="terms-desc"
              />
              <span id="terms-desc" className="text-sm text-foreground">
                Mit der Bestätigung stimme ich den{" "}
                <button
                  type="button"
                  className="text-primary underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-primary rounded inline"
                  onClick={(e) => {
                    e.preventDefault();
                    window.electron?.openExternal(URL_PRIVACY_DESKTOP);
                  }}
                >
                  Datenschutzhinweisen (App &amp; Relay)
                </button>
                {", der "}
                <button
                  type="button"
                  className="text-primary underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-primary rounded inline"
                  onClick={(e) => {
                    e.preventDefault();
                    window.electron?.openExternal(URL_EULA_DESKTOP);
                  }}
                >
                  EULA
                </button>
                {" sowie den "}
                <button
                  type="button"
                  className="text-primary underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-primary rounded inline"
                  onClick={(e) => {
                    e.preventDefault();
                    window.electron?.openExternal(URL_SECURITY_REMOTE);
                  }}
                >
                  Security-/Remote-Control-Hinweisen
                </button>
                {" von Broadify Bridge zu und habe diese gelesen."}
              </span>
            </label>

            {error && (
              <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-md p-2">
                {error}
              </div>
            )}

            <div className="flex justify-end">
              <Button
                onClick={handleAcceptTerms}
                disabled={!termsChecked || accepting}
              >
                {accepting ? "Wird gespeichert…" : "Akzeptieren"}
              </Button>
            </div>
          </>
        )}

        {step === "name" && (
          <>
            <div>
              <h2 className="text-xl font-bold text-foreground">Bridge-Name</h2>
              <p className="text-sm text-muted-foreground">
                Bitte wählen Sie einen eindeutigen Namen, damit Sie Ihre Bridge
                später wiederfinden.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-semibold text-foreground">
                Name
              </label>
              <Input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (error) setError(null);
                }}
                placeholder="z. B. Studio A"
                maxLength={64}
              />
              {error && (
                <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-md p-2">
                  {error}
                </div>
              )}
            </div>

            <div className="flex justify-end">
              <Button onClick={handleSaveName} disabled={saving}>
                {saving ? "Wird gespeichert…" : "Speichern"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
