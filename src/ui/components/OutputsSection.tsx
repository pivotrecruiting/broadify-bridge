import { Card } from "@/components/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { OutputDeviceT } from "@broadify/protocol";

interface OutputsSectionProps {
  output1: string;
  output2: string;
  output1Options: OutputDeviceT[];
  output2Options: OutputDeviceT[];
  loading?: boolean;
  onOutput1Change: (value: string) => void;
  onOutput2Change: (value: string) => void;
}

/**
 * Outputs section component with output 1 and 2 selection
 */
export function OutputsSection({
  output1,
  output2,
  output1Options,
  output2Options,
  loading = false,
  onOutput1Change,
  onOutput2Change,
}: OutputsSectionProps) {
  const hasAvailableOutput1 = output1Options.some((opt) => opt.available);
  const hasAvailableOutput2 = output2Options.some((opt) => opt.available);

  // Fallback to first available option if current selection is not present
  const currentOutput1 = output1Options.find(
    (opt) => opt.id === output1 || opt.name === output1
  );
  const currentOutput2 = output2Options.find(
    (opt) => opt.id === output2 || opt.name === output2
  );
  const fallbackOutput1 = output1Options.find((opt) => opt.available);
  const fallbackOutput2 = output2Options.find((opt) => opt.available);

  const displayOutput1 =
    currentOutput1?.id || fallbackOutput1?.id || output1;
  const displayOutput2 =
    currentOutput2?.id || fallbackOutput2?.id || output2;

  return (
    <Card variant="frosted" className="p-4 sm:p-5 md:p-6" gradient>
      <div className="grid grid-cols-1 md:grid-cols-[100px_1fr] lg:grid-cols-[120px_1fr] gap-4 md:gap-6">
        <h2 className="text-card-foreground font-bold text-base sm:text-lg md:text-lg">
          Outputs
        </h2>
        <div className="space-y-3 sm:space-y-4">
          <div className="flex items-center gap-2 sm:gap-3">
            <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px]">
              1
            </label>
            <Select
              value={displayOutput1}
              onValueChange={onOutput1Change}
              disabled={loading || !hasAvailableOutput1}
            >
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue placeholder={loading ? "Loading..." : "Select output"} />
              </SelectTrigger>
              <SelectContent>
                {output1Options.length === 0 ? (
                  <SelectItem value="no-outputs" disabled>
                    {loading ? "Loading outputs..." : "No outputs detected"}
                  </SelectItem>
                ) : (
                  output1Options.map((output) => (
                    <SelectItem
                      key={output.id}
                      value={output.id}
                      disabled={!output.available}
                    >
                      {output.name}
                      {!output.available ? " (unavailable)" : ""}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px]">
              2
            </label>
            <Select
              value={displayOutput2}
              onValueChange={onOutput2Change}
              disabled={loading || !hasAvailableOutput2}
            >
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue placeholder={loading ? "Loading..." : "Select output"} />
              </SelectTrigger>
              <SelectContent>
                {output2Options.length === 0 ? (
                  <SelectItem value="no-outputs" disabled>
                    {loading ? "Loading outputs..." : "No outputs detected"}
                  </SelectItem>
                ) : (
                  output2Options.map((output) => (
                    <SelectItem
                      key={output.id}
                      value={output.id}
                      disabled={!output.available}
                    >
                      {output.name}
                      {!output.available ? " (unavailable)" : ""}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </Card>
  );
}
