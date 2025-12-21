import { Card } from "@/components/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OUTPUT1_OPTIONS, OUTPUT2_OPTIONS } from "../constants/output-constants";

interface OutputsSectionProps {
  output1: string;
  output2: string;
  onOutput1Change: (value: string) => void;
  onOutput2Change: (value: string) => void;
}

/**
 * Outputs section component with output 1 and 2 selection
 */
export function OutputsSection({
  output1,
  output2,
  onOutput1Change,
  onOutput2Change,
}: OutputsSectionProps) {
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
            <Select value={output1} onValueChange={onOutput1Change}>
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OUTPUT1_OPTIONS.map((output) => (
                  <SelectItem key={output} value={output}>
                    {output}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px]">
              2
            </label>
            <Select value={output2} onValueChange={onOutput2Change}>
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OUTPUT2_OPTIONS.map((output) => (
                  <SelectItem key={output} value={output}>
                    {output}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </Card>
  );
}

