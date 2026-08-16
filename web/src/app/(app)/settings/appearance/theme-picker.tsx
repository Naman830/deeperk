"use client";

import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemePreference } from "@/components/features/shell/theme-provider";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const OPTIONS: { value: ThemePreference; label: string; description: string; icon: typeof Sun }[] = [
  { value: "dark", label: "Dark", description: "The default look.", icon: Moon },
  { value: "light", label: "Light", description: "Bright surfaces.", icon: Sun },
  { value: "system", label: "System", description: "Follow your device setting.", icon: Monitor },
];

export function ThemePicker() {
  const { preference, setPreference } = useTheme();

  return (
    <Card>
      <CardContent className="flex flex-col gap-1">
        {OPTIONS.map(({ value, label, description, icon: Icon }) => {
          const selected = preference === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={selected}
              onClick={() => setPreference(value)}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors",
                selected ? "bg-accent text-accent-foreground" : "hover:bg-muted",
              )}
            >
              <Icon size={18} className="shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{label}</span>
                <span className={cn("block text-xs", selected ? "opacity-80" : "text-muted-foreground")}>{description}</span>
              </span>
              {selected && <Check size={16} className="shrink-0" />}
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}
