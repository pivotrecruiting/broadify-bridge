import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface BridgeNameDialogProps {
  isOpen: boolean;
  initialName?: string | null;
  onSave: (name: string) => Promise<{ success: boolean; error?: string }>;
}

/**
 * Modal dialog that forces users to set a bridge name before starting.
 */
export function BridgeNameDialog({
  isOpen,
  initialName,
  onSave,
}: BridgeNameDialogProps) {
  const [name, setName] = useState(initialName || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName(initialName || "");
      setError(null);
    }
  }, [isOpen, initialName]);

  if (!isOpen) return null;

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Please enter a bridge name.");
      return;
    }

    setSaving(true);
    setError(null);
    const result = await onSave(trimmed);
    if (!result.success) {
      setError(result.error || "Save failed");
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />

      <div className="relative w-full max-w-lg rounded-lg bg-white border border-white/20 shadow-2xl p-6 space-y-4">
        <div>
          <h2 className="text-xl font-bold text-foreground">Bridge Name</h2>
          <p className="text-sm text-muted-foreground">
            Please choose a unique name so you can find your bridge later.
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-semibold text-foreground">Name</label>
          <Input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError(null);
            }}
            placeholder="e.g. Studio A"
            maxLength={64}
          />
          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-md p-2">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
