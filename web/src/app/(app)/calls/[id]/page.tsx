import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, MessageSquare, PhoneIncoming, PhoneMissed, PhoneOutgoing, Users } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { getCallDetail, type CallDetail, type CallRosterEntry } from "@/lib/call/history";
import { callStatusText, formatCallDuration } from "@/lib/call/call-message";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import { MainPane } from "@/components/features/shell/main-pane";
import { avatarUrl } from "@/lib/avatar-url";
import { cn } from "@/lib/utils";
import { CallBackButton } from "../call-back-button";
import { CallTime } from "../call-time";

// cache() so generateMetadata and the page share one round trip rather than
// running the same query twice per navigation.
const loadCall = cache(getCallDetail);

// NOTE: this segment must never gain a loading.tsx. It calls notFound(), and a
// Suspense boundary starts streaming — headers flush, and the 404 silently
// becomes a 200. Already observed and documented in this repo for
// /u/[username].

function callTitle(detail: CallDetail): string {
  if (detail.conversationType === "GROUP") return detail.conversationName ?? "Group";
  if (!detail.counterpart) return "Conversation";
  return `${detail.counterpart.firstName} ${detail.counterpart.lastName ?? ""}`.trim();
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const session = await getSession();
  if (!session) return { title: "Calls" };
  const { id } = await params;
  const detail = await loadCall(id, session.user.id);
  if (!detail) return { title: "Calls" };
  return {
    title: detail.conversationType === "GROUP" ? `Call · ${callTitle(detail)}` : `Call with ${callTitle(detail)}`,
  };
}

export default async function CallDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { id } = await params;
  // Null for "no such call" and "not a member" alike, so both render one
  // identical 404 and membership can't be probed by status code.
  const detail = await loadCall(id, session.user.id);
  if (!detail) notFound();

  const isCaller = detail.direction === "outgoing";
  const missed = !isCaller && (detail.status === "MISSED" || detail.status === "REJECTED");
  const isGroup = detail.conversationType === "GROUP";
  const live = detail.status === "RINGING" || detail.status === "ONGOING";
  const title = callTitle(detail);
  const statusLine = callStatusText(detail.status, detail.kind, detail.durationSec, isCaller);
  const DirectionIcon = missed ? PhoneMissed : isCaller ? PhoneOutgoing : PhoneIncoming;

  return (
    <MainPane>
      <header className="bg-background/80 flex h-14 shrink-0 items-center gap-2 border-b px-2 backdrop-blur md:px-4">
        <Button asChild variant="ghost" size="icon-sm" className="md:hidden">
          <Link href="/calls" aria-label="Back to calls">
            <ArrowLeft />
          </Link>
        </Button>
        {isGroup ? (
          <Avatar className="size-10">
            {detail.conversationAvatarPublicId && (
              <AvatarImage src={avatarUrl(detail.conversationAvatarPublicId, 96) ?? undefined} alt="" />
            )}
            <AvatarFallback className="bg-primary/15 text-primary">
              <Users size={18} />
            </AvatarFallback>
          </Avatar>
        ) : (
          <UserAvatar
            src={avatarUrl(detail.counterpart?.avatarPublicId, 96)}
            firstName={detail.counterpart?.firstName}
            lastName={detail.counterpart?.lastName}
          />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          <p className="text-muted-foreground truncate text-xs">
            {detail.kind === "VIDEO" ? "Video call" : "Audio call"} · {isCaller ? "Outgoing" : "Incoming"}
          </p>
        </div>
        <CallBackButton
          conversationId={detail.conversationId}
          kind={detail.kind}
          label={live ? "Join call" : `Call ${title} again`}
          size="sm"
          variant="default"
          text={live ? "Join call" : "Call again"}
        />
      </header>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
          <section className="rounded-lg border p-4">
            <div className="flex items-center gap-2">
              <DirectionIcon size={16} className={cn("shrink-0", missed ? "text-destructive" : "text-muted-foreground")} />
              <span className={cn("text-sm font-medium", missed && "text-destructive")}>{statusLine}</span>
            </div>
            <dl className="text-muted-foreground mt-3 flex flex-col gap-1.5 text-xs">
              <div className="flex items-baseline justify-between gap-4">
                <dt>Started</dt>
                <dd>
                  <CallTime iso={detail.startedAt} full />
                </dd>
              </div>
              {detail.durationSec !== null && (
                <div className="flex items-baseline justify-between gap-4">
                  <dt>Duration</dt>
                  <dd>{formatCallDuration(detail.durationSec)}</dd>
                </div>
              )}
            </dl>
          </section>

          {detail.roster.length > 0 && (
            <section className="rounded-lg border p-4">
              <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Participants ({detail.roster.length})
              </h2>
              <ul className="mt-2 flex flex-col gap-1">
                {detail.roster.map((person) => (
                  <RosterRow key={person.user.id} person={person} live={live} viewerId={session.user.id} />
                ))}
              </ul>
            </section>
          )}

          <Button asChild variant="outline" className="self-start">
            <Link href={`/chats/${detail.conversationId}`}>
              <MessageSquare /> Open chat
            </Link>
          </Button>
        </div>
      </div>
    </MainPane>
  );
}

// Deliberately neutral wording (call.md §2.5): a decline is only ever revealed
// to the caller, and only via the status line above — a roster row never says
// "Declined", so group rejecters read identically to ring-outs.
function rosterStatus(person: CallRosterEntry, live: boolean): string {
  if (person.joinedAt === null) return live ? "Ringing…" : "Didn't join";
  if (live) return person.leftAt ? "Left the call" : "In call";
  return person.isStarter ? "Started the call" : "Joined";
}

function RosterRow({ person, live, viewerId }: { person: CallRosterEntry; live: boolean; viewerId: string }) {
  const name = `${person.user.firstName} ${person.user.lastName ?? ""}`.trim();
  return (
    <li className="flex items-center gap-3 py-1.5">
      <UserAvatar
        src={avatarUrl(person.user.avatarPublicId, 96)}
        firstName={person.user.firstName}
        lastName={person.user.lastName}
        size="sm"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">
          {name}
          {person.user.id === viewerId && <span className="text-muted-foreground"> (you)</span>}
        </span>
        <span className="text-muted-foreground block truncate text-xs">{rosterStatus(person, live)}</span>
      </span>
      {person.talkSec !== null && (
        <span className="text-muted-foreground shrink-0 text-xs">{formatCallDuration(person.talkSec)}</span>
      )}
    </li>
  );
}
