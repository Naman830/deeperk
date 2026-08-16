import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

// Deliberately no "use client": it takes an onChange function prop, so it can only
// ever be rendered from a client component and inherits that boundary. Adding the
// directive would create a second one for nothing.

// The chats column and the full-page /search differed only in these three numbers.
const SIZES = {
  sm: { icon: 15, position: "left-2.5", input: "h-9 pl-8" },
  lg: { icon: 16, position: "left-3", input: "h-11 pl-9" },
} as const;

type UserSearchInputProps = {
  value: string;
  onChange: (value: string) => void;
  size?: keyof typeof SIZES;
  autoFocus?: boolean;
};

// The single people-search field. Placeholder and aria-label live here rather than
// at each call site so both entry points read identically (Docs/user/search.md §2).
export function UserSearchInput({ value, onChange, size = "sm", autoFocus }: UserSearchInputProps) {
  const { icon, position, input } = SIZES[size];

  return (
    <div className="relative">
      <Search size={icon} className={`text-muted-foreground pointer-events-none absolute top-1/2 ${position} -translate-y-1/2`} />
      <Input
        type="search"
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search people by username"
        aria-label="Search people by username"
        className={input}
      />
    </div>
  );
}
