import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

// Dimensions and the matching initials size are kept together — shadcn's own
// fallback hard-codes text-sm, which is unreadably small at the xl size.
const SIZES = {
  sm: { box: "size-8", text: "text-xs" },
  md: { box: "size-10", text: "text-sm" },
  lg: { box: "size-16", text: "text-lg" },
  xl: { box: "size-28", text: "text-3xl" },
} as const;

type UserAvatarProps = {
  src?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  size?: keyof typeof SIZES;
  // Presence. `undefined` renders no dot at all — the API omits online status
  // entirely when privacy hides it, so absent must stay visibly absent.
  isOnline?: boolean;
  className?: string;
};

function initials(firstName?: string | null, lastName?: string | null) {
  // Array.from, not [0], so an emoji or astral-plane name isn't split mid-codepoint.
  const first = Array.from(firstName?.trim() ?? "")[0] ?? "";
  const last = Array.from(lastName?.trim() ?? "")[0] ?? "";
  return (first + last).toUpperCase() || "?";
}

export function UserAvatar({ src, firstName, lastName, size = "md", isOnline, className }: UserAvatarProps) {
  const { box, text } = SIZES[size];

  return (
    <Avatar className={cn(box, className)}>
      {src && <AvatarImage src={src} alt="" />}
      {/* Brand-tinted rather than bg-muted: a muted-on-muted initial disappears
          against the sidebar, which is the same colour family. */}
      <AvatarFallback className={cn("bg-primary/15 text-primary font-medium", text)}>{initials(firstName, lastName)}</AvatarFallback>
      {isOnline !== undefined && (
        <AvatarBadge aria-label={isOnline ? "Online" : "Offline"} className={cn("size-3", isOnline ? "bg-success" : "bg-muted-foreground")} />
      )}
    </Avatar>
  );
}
