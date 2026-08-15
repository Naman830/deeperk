"use client";

import { useState } from "react";

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

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-3.27 2.9A9.14 9.14 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 4.22-5.94M1 1l22 22" />
      <path d="M14.12 14.12A3 3 0 1 1 9.88 9.88" />
    </svg>
  );
}

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
  const [visible, setVisible] = useState(false);
  const isPasswordToggle = type === "password" && showPasswordToggle;
  const inputType = isPasswordToggle ? (visible ? "text" : "password") : type;

  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      <div className="relative">
        <input
          name={name}
          type={inputType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          placeholder={placeholder}
          className={`w-full rounded-md border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground ${isPasswordToggle ? "pr-10" : ""}`}
        />
        {isPasswordToggle && (
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? "Hide password" : "Show password"}
            className="text-muted hover:text-foreground absolute inset-y-0 right-0 flex items-center px-3"
          >
            {visible ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        )}
      </div>
      {requirements && (
        <ul className="flex flex-col gap-0.5">
          {requirements.rules.map((rule) => {
            const met = rule.test(value);
            return (
              <li key={rule.label} className={met ? "text-green-500" : "text-muted"}>
                {met ? "✓" : "○"} {rule.label}
              </li>
            );
          })}
        </ul>
      )}
      {error && <span className="text-red-500">{error}</span>}
    </label>
  );
}
