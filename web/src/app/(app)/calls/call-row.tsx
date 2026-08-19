import Link from "next/link";
import { PhoneIncoming, PhoneMissed, PhoneOutgoing, Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import { avatarUrl } from "@/lib/avatar-url";
import { callStatusText } from "@/lib/call/call-message";
import type { CallHistoryEntry } from "@/lib/call/history";
import { cn } from "@/lib/utils";
import { CallBackButton } from "./call-back-button";
import { CallTime } from "./call-time";

// No "use client": rendered from call-history-pager, which is already inside
// the client boundary — same posture as conversation-row. The row links to
// /calls/[id] via a stretched link (an <a> wrapping the whole row would nest
// CallBackButton's real <button>, which is invalid HTML): the <li> is relative,
// the Link's ::after overlay covers it, and the button sits above on z-10.
export function CallRow({ entry, active = false }: { entry: CallHistoryEntry; active?: boolean }) {
  const isCaller = entry.direction === "outgoing";
  const missed = !isCaller && (entry.status === "MISSED" || entry.status === "REJECTED");
  const isGroup = entry.conversationType === "GROUP";

  const title = isGroup
    ? (entry.conversationName ?? "Group")
    : entry.counterpart
      ? `${entry.counterpart.firstName} ${entry.counterpart.lastName ?? ""}`.trim()
      : "Conversation";

  const status = callStatusText(entry.status, entry.kind, entry.durationSec, isCaller);
  const line = isGroup ? `${isCaller ? "You started" : `Started by ${entry.starter.firstName}`} · ${status}` : status;

  const DirectionIcon = missed ? PhoneMissed : isCaller ? PhoneOutgoing : PhoneIncoming;

  return (
    <li
      className={cn(
        "relative flex items-center gap-3 rounded-lg px-2 py-2 transition-colors",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/50",
      )}
    >
      {isGroup ? (
        <Avatar className="size-10">
          {entry.conversationAvatarPublicId && (
            <AvatarImage src={avatarUrl(entry.conversationAvatarPublicId, 96) ?? undefined} alt="" />
          )}
          <AvatarFallback className="bg-primary/15 text-primary">
            <Users size={18} />
          </AvatarFallback>
        </Avatar>
      ) : (
        <UserAvatar
          src={avatarUrl(entry.counterpart?.avatarPublicId, 96)}
          firstName={entry.counterpart?.firstName}
          lastName={entry.counterpart?.lastName}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <Link
            href={`/calls/${entry.id}`}
            aria-current={active ? "page" : undefined}
            className="min-w-0 flex-1 truncate text-sm font-medium after:absolute after:inset-0 after:rounded-lg"
          >
            {title}
          </Link>
          <CallTime iso={entry.startedAt} />
        </span>
        <span className="flex items-center gap-1.5">
          <DirectionIcon
            size={13}
            className={cn("shrink-0", missed ? "text-destructive" : "text-muted-foreground")}
            aria-label={isCaller ? "Outgoing" : "Incoming"}
          />
          <span className={cn("min-w-0 flex-1 truncate text-xs", missed ? "text-destructive" : "text-muted-foreground")}>
            {line}
          </span>
        </span>
      </span>
      <CallBackButton
        conversationId={entry.conversationId}
        kind={entry.kind}
        label={`Call ${title} back`}
        className="relative z-10"
      />
    </li>
  );
}
