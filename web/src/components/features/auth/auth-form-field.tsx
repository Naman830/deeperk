import { useId, useState } from "react";
import { Check, Circle, Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

type Requirement = { label: string; test: (value: string) => boolean };

type AuthFormFieldProps = {
  label: string;
  name: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  autoFocus?: boolean;
  autoComplete?: string;
  placeholder?: string;
  // Renders an eye icon that toggles this field between masked and plain text. Only meaningful when type="password".
  showPasswordToggle?: boolean;
  // Renders a live checklist below the input, each rule checked against the current value.
  requirements?: { rules: Requirement[] };
};

export function AuthFormField({
  label,
  name,
  type = "text",
  value,
  onChange,
  error,
  autoFocus,
  autoComplete,
  placeholder,
  showPasswordToggle,
  requirements,
}: AuthFormFieldProps) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const isPasswordToggle = type === "password" && showPasswordToggle;
  const inputType = isPasswordToggle ? (visible ? "text" : "password") : type;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          name={name}
          type={inputType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          className={`h-10 ${isPasswordToggle ? "pr-10" : ""}`}
        />
        {isPasswordToggle && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={visible ? "Hide password" : "Show password"}
            onClick={() => setVisible((v) => !v)}
            className="absolute inset-y-0 right-1 my-auto"
          >
            {visible ? <EyeOff /> : <Eye />}
          </Button>
        )}
      </div>
      {requirements && (
        <ul className="flex flex-col gap-0.5">
          {requirements.rules.map((rule) => {
            const met = rule.test(value);
            return (
              <li key={rule.label} className={`flex items-center gap-1.5 text-xs ${met ? "text-success" : "text-muted-foreground"}`}>
                {met ? <Check size={13} /> : <Circle size={13} />} {rule.label}
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
