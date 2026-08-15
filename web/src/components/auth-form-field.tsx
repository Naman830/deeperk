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
}: AuthFormFieldProps) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      <input
        name={name}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        placeholder={placeholder}
        className="rounded-md border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
      />
      {error && <span className="text-red-500">{error}</span>}
    </label>
  );
}
