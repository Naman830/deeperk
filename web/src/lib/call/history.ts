import { and, asc, count, desc, eq, inArray, ne, sql } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { call, callParticipant, conversation, conversationMember, user } from "../../../../db/schema";
import type { ConversationType } from "@/lib/chat/types";
import type { CallKind, CallLiveStatus, CallTerminalStatus, CallUser } from "./types";

export const CALL_HISTORY_PAGE_SIZE = 50;
export const CALL_HISTORY_MAX_PAGE_SIZE = 100;

export type CallStatus = CallLiveStatus | CallTerminalStatus;
export type CallDirection = "outgoing" | "incoming";

export type CallHistoryEntry = {
  id: string;
  conversationId: string;
  conversationType: ConversationType;
  conversationName: string | null;
  /** Group avatar — DIRECT rows use the counterpart's avatar instead. */
  conversationAvatarPublicId: string | null;
  kind: CallKind;
  status: CallStatus;
  startedAt: string;
  endedAt: string | null;
  /** endedAt − min(non-caller joinedAt), both Neon-clock; ≤1s off the bubble's
   *  app-clock figure, accepted. Null unless ENDED with an answer. */
  durationSec: number | null;
  direction: CallDirection;
  /** DIRECT only — the other member. */
  counterpart: CallUser | null;
  starter: CallUser;
  /** Members who actually joined (caller included). */
  participantCount: number;
};

/** Same shape as formatMessageCursor. Parse lives right below so the pair can
 *  never drift; /api/calls is the only consumer of the parse half. */
export function formatCallCursor(startedAt: Date, id: string): string {
  return `${startedAt.getTime()}.${id}`;
}

/** Mirrors parseMessageCursor, tri-state included: null = no cursor, "invalid"
 *  = malformed (the route answers 400 — falling back to page 1 would loop the
 *  client's pager forever). */
export function parseCallCursor(raw: string | null): { startedAt: Date; id: string } | null | "invalid" {
  if (raw === null || raw === "") return null;
  const separator = raw.indexOf(".");
  if (separator <= 0) return "invalid";
  const millis = Number(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (!Number.isSafeInteger(millis) || millis <= 0 || !id) return "invalid";
  return { startedAt: new Date(millis), id };
}

/**
 * The /calls history feed. Scoped by conversation MEMBERSHIP, never by
 * call_participant — a MISSED call has no callee participant row yet must
 * appear in the callee's history.
 *
 * Three bounded queries: the keyset page, the DIRECT counterparts, and one
 * grouped participant aggregate — never one query per call.
 */
export async function listCallHistory(
  viewerId: string,
  options: { before?: { startedAt: Date; id: string }; limit?: number } = {},
): Promise<{ entries: CallHistoryEntry[]; nextCursor: string | null; hasMore: boolean }> {
  const limit = Math.min(options.limit ?? CALL_HISTORY_PAGE_SIZE, CALL_HISTORY_MAX_PAGE_SIZE);
  const { before } = options;

  // 1. Page of calls + conversation + starter, newest first.
  const rows = await db
    .select({
      id: call.id,
      conversationId: call.conversationId,
      conversationType: conversation.type,
      conversationName: conversation.name,
      conversationAvatarPublicId: conversation.avatarPublicId,
      kind: call.kind,
      status: call.status,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      starterId: user.id,
      starterUsername: user.username,
      starterFirstName: user.firstName,
      starterLastName: user.lastName,
      starterAvatarPublicId: user.avatarPublicId,
    })
    .from(call)
    .innerJoin(
      conversationMember,
      and(eq(conversationMember.conversationId, call.conversationId), eq(conversationMember.userId, viewerId)),
    )
    .innerJoin(conversation, eq(conversation.id, call.conversationId))
    .innerJoin(user, eq(user.id, call.startedById))
    .where(
      before
        ? sql`(${call.startedAt}, ${call.id}) < (${before.startedAt.toISOString()}::timestamptz, ${before.id})`
        : undefined,
    )
    .orderBy(desc(call.startedAt), desc(call.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  if (page.length === 0) return { entries: [], nextCursor: null, hasMore: false };

  const callIds = page.map((row) => row.id);
  const directIds = [
    ...new Set(page.filter((row) => row.conversationType === "DIRECT").map((row) => row.conversationId)),
  ];

  const [counterpartRows, joinStats] = await Promise.all([
    // 2. DM counterparts, one row per DIRECT conversation on the page.
    directIds.length > 0
      ? db
          .select({
            conversationId: conversationMember.conversationId,
            id: user.id,
            username: user.username,
            firstName: user.firstName,
            lastName: user.lastName,
            avatarPublicId: user.avatarPublicId,
          })
          .from(conversationMember)
          .innerJoin(user, eq(user.id, conversationMember.userId))
          .where(and(inArray(conversationMember.conversationId, directIds), ne(conversationMember.userId, viewerId)))
      : [],

    // 3. Per-call joined count + first non-caller answer, for the duration.
    //    count(joinedAt) skips NULLs, so rung-but-never-joined rows don't count.
    db
      .select({
        callId: callParticipant.callId,
        joinedCount: count(callParticipant.joinedAt),
        firstAnswerAt: sql`min(${callParticipant.joinedAt}) filter (where ${callParticipant.userId} <> ${call.startedById})`.mapWith(
          callParticipant.joinedAt,
        ),
      })
      .from(callParticipant)
      .innerJoin(call, eq(call.id, callParticipant.callId))
      .where(inArray(callParticipant.callId, callIds))
      .groupBy(callParticipant.callId),
  ]);

  const counterpartByConversation = new Map(
    counterpartRows.map((row) => [
      row.conversationId,
      {
        id: row.id,
        username: row.username,
        firstName: row.firstName,
        lastName: row.lastName,
        avatarPublicId: row.avatarPublicId,
      } satisfies CallUser,
    ]),
  );
  const statsByCall = new Map(joinStats.map((row) => [row.callId, row]));

  const entries = page.map((row): CallHistoryEntry => {
    const stats = statsByCall.get(row.id);
    const firstAnswerAt = stats?.firstAnswerAt ?? null;
    const durationSec =
      row.status === "ENDED" && row.endedAt && firstAnswerAt
        ? Math.max(0, Math.floor((row.endedAt.getTime() - firstAnswerAt.getTime()) / 1000))
        : null;
    return {
      id: row.id,
      conversationId: row.conversationId,
      conversationType: row.conversationType,
      conversationName: row.conversationName,
      conversationAvatarPublicId: row.conversationAvatarPublicId,
      kind: row.kind,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
      durationSec,
      direction: row.starterId === viewerId ? "outgoing" : "incoming",
      counterpart:
        row.conversationType === "DIRECT" ? (counterpartByConversation.get(row.conversationId) ?? null) : null,
      starter: {
        id: row.starterId,
        username: row.starterUsername,
        firstName: row.starterFirstName,
        lastName: row.starterLastName,
        avatarPublicId: row.starterAvatarPublicId,
      },
      participantCount: stats ? Number(stats.joinedCount) : 0,
    };
  });

  const oldest = page[page.length - 1];
  return {
    entries,
    nextCursor: hasMore && oldest ? formatCallCursor(oldest.startedAt, oldest.id) : null,
    hasMore,
  };
}

export type CallRosterEntry = {
  user: CallUser;
  isStarter: boolean;
  /** Null = rung but never joined (call.md §4: same row shape, no special case). */
  joinedAt: string | null;
  leftAt: string | null;
  /** (leftAt ?? endedAt) − joinedAt, seconds; null until they joined and either
   *  left or the call ended. */
  talkSec: number | null;
};

export type CallDetail = CallHistoryEntry & { roster: CallRosterEntry[] };

/**
 * One call for /calls/[id]. Same membership gate as the list, and null covers
 * "no such call" and "not a member" alike, so the page renders one identical
 * 404 either way and membership can't be probed by status code.
 *
 * participantCount / durationSec are derived from the roster in JS instead of
 * re-running the list's grouped aggregate — same numbers, one query fewer.
 */
export async function getCallDetail(callId: string, viewerId: string): Promise<CallDetail | null> {
  const rows = await db
    .select({
      id: call.id,
      conversationId: call.conversationId,
      conversationType: conversation.type,
      conversationName: conversation.name,
      conversationAvatarPublicId: conversation.avatarPublicId,
      kind: call.kind,
      status: call.status,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      starterId: user.id,
      starterUsername: user.username,
      starterFirstName: user.firstName,
      starterLastName: user.lastName,
      starterAvatarPublicId: user.avatarPublicId,
    })
    .from(call)
    .innerJoin(
      conversationMember,
      and(eq(conversationMember.conversationId, call.conversationId), eq(conversationMember.userId, viewerId)),
    )
    .innerJoin(conversation, eq(conversation.id, call.conversationId))
    .innerJoin(user, eq(user.id, call.startedById))
    .where(eq(call.id, callId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const [counterpartRows, rosterRows] = await Promise.all([
    row.conversationType === "DIRECT"
      ? db
          .select({
            id: user.id,
            username: user.username,
            firstName: user.firstName,
            lastName: user.lastName,
            avatarPublicId: user.avatarPublicId,
          })
          .from(conversationMember)
          .innerJoin(user, eq(user.id, conversationMember.userId))
          .where(and(eq(conversationMember.conversationId, row.conversationId), ne(conversationMember.userId, viewerId)))
      : [],

    db
      .select({
        id: user.id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        avatarPublicId: user.avatarPublicId,
        joinedAt: callParticipant.joinedAt,
        leftAt: callParticipant.leftAt,
      })
      .from(callParticipant)
      .innerJoin(user, eq(user.id, callParticipant.userId))
      .where(eq(callParticipant.callId, callId))
      // Postgres ASC puts NULLs last: joiners in join order, never-joined after.
      .orderBy(asc(callParticipant.joinedAt)),
  ]);

  const roster = rosterRows.map((person): CallRosterEntry => {
    const end = person.leftAt ?? row.endedAt;
    return {
      user: {
        id: person.id,
        username: person.username,
        firstName: person.firstName,
        lastName: person.lastName,
        avatarPublicId: person.avatarPublicId,
      },
      isStarter: person.id === row.starterId,
      joinedAt: person.joinedAt?.toISOString() ?? null,
      leftAt: person.leftAt?.toISOString() ?? null,
      talkSec:
        person.joinedAt && end ? Math.max(0, Math.floor((end.getTime() - person.joinedAt.getTime()) / 1000)) : null,
    };
  });

  let firstAnswerAt: Date | null = null;
  for (const person of rosterRows) {
    if (person.id === row.starterId || !person.joinedAt) continue;
    if (firstAnswerAt === null || person.joinedAt < firstAnswerAt) firstAnswerAt = person.joinedAt;
  }
  const durationSec =
    row.status === "ENDED" && row.endedAt && firstAnswerAt
      ? Math.max(0, Math.floor((row.endedAt.getTime() - firstAnswerAt.getTime()) / 1000))
      : null;

  const counterpartRow = counterpartRows[0];
  return {
    id: row.id,
    conversationId: row.conversationId,
    conversationType: row.conversationType,
    conversationName: row.conversationName,
    conversationAvatarPublicId: row.conversationAvatarPublicId,
    kind: row.kind,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    durationSec,
    direction: row.starterId === viewerId ? "outgoing" : "incoming",
    counterpart:
      row.conversationType === "DIRECT" && counterpartRow
        ? {
            id: counterpartRow.id,
            username: counterpartRow.username,
            firstName: counterpartRow.firstName,
            lastName: counterpartRow.lastName,
            avatarPublicId: counterpartRow.avatarPublicId,
          }
        : null,
    starter: {
      id: row.starterId,
      username: row.starterUsername,
      firstName: row.starterFirstName,
      lastName: row.starterLastName,
      avatarPublicId: row.starterAvatarPublicId,
    },
    participantCount: rosterRows.filter((person) => person.joinedAt).length,
    roster,
  };
}
