import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { NetworkBindingOptionT } from "@broadify/protocol";

interface NetworkInterfaceSelectorProps {
  value: string;
  options: NetworkBindingOptionT[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * Network interface selector component with recommended markers
 */
export function NetworkInterfaceSelector({
  value,
  options,
  onChange,
  disabled,
}: NetworkInterfaceSelectorProps) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-full sm:w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            <div className="flex items-center gap-2">
              <span>{option.label}</span>
              {option.bindAddress !== "0.0.0.0" &&
                option.bindAddress !== "127.0.0.1" && (
                  <span className="text-xs text-card-foreground/60">
                    ({option.bindAddress})
                  </span>
                )}
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
