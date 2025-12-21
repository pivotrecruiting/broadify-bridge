import { Card } from "@/components/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ENGINE_ATEM_OPTIONS, ENGINE_PORT_OPTIONS } from "../constants/engine-constants";

interface EngineSectionProps {
  engineAtem: string;
  enginePort: string;
  onAtemChange: (value: string) => void;
  onPortChange: (value: string) => void;
}

/**
 * Engine section component with ATEM and port selection
 */
export function EngineSection({
  engineAtem,
  enginePort,
  onAtemChange,
  onPortChange,
}: EngineSectionProps) {
  return (
    <Card variant="frosted" className="p-4 sm:p-5 md:p-6" gradient>
      <div className="grid grid-cols-1 md:grid-cols-[100px_1fr] lg:grid-cols-[120px_1fr] gap-4 md:gap-6 items-center">
        <h2 className="text-card-foreground font-bold text-base sm:text-lg md:text-lg">
          Engine
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 md:gap-6">
          <div className="flex items-center gap-2 sm:gap-3">
            <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px] opacity-0 pointer-events-none">
              {/* Invisible label for alignment */}
            </label>
            <Select value={engineAtem} onValueChange={onAtemChange}>
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
              Port
            </label>
            <Select value={enginePort} onValueChange={onPortChange}>
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
      </div>
    </Card>
  );
}

