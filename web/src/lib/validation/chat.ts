import { z } from "zod";

// Chat rules per Docs/chat/chat.md §2.3, §2.4, §7, §8. Shared between the
// client (inline feedback before a bubble is ever created) and the server /
// socket handlers, which never trust that the client-side check ran.

export const MESSAGE_MAX_LENGTH = 4000;

// Trimmed, because a message of only whitespace is an empty message. The
// client blocks over-length before sending so §8's "rejected, inline error"
// never has to arrive after an optimistic bubble already exists.
export const messageBodySchema = z
  .string()
  .trim()
  .min(1, "Type a message")
  .max(MESSAGE_MAX_LENGTH, `Messages can be up to ${MESSAGE_MAX_LENGTH} characters`);

export const GROUP_NAME_MAX = 50;
export const GROUP_MIN_MEMBERS = 2; // including the creator
export const GROUP_MAX_MEMBERS = 20;

export const groupNameSchema = z
  .string()
  .trim()
  .min(1, "Give the group a name")
  .max(GROUP_NAME_MAX, `Group name must be ${GROUP_NAME_MAX} characters or fewer`);

// Usernames, not ids: no user id is exposed to the browser anywhere in this
// app (search returns handles, getPublicProfile strips `id`), so the server
// resolves them in the same lookup it already needs for the discoverable gate.
const usernameRef = z.string().trim().toLowerCase().min(3).max(30);

export const startDirectSchema = z.object({
  username: usernameRef,
});

export const createGroupSchema = z.object({
  name: groupNameSchema,
  // The creator is added server-side, so the payload carries everyone else.
  memberUsernames: z
    .array(usernameRef)
    .min(GROUP_MIN_MEMBERS - 1, "Add at least one other person")
    .max(GROUP_MAX_MEMBERS - 1, `A group can have up to ${GROUP_MAX_MEMBERS} members`),
});

export const renameGroupSchema = z.object({
  name: groupNameSchema,
});

export const addMembersSchema = z.object({
  usernames: z
    .array(usernameRef)
    .min(1, "Pick someone to add")
    .max(GROUP_MAX_MEMBERS - 1, `A group can have up to ${GROUP_MAX_MEMBERS} members`),
});

// OWNER is transferred, never assigned — see the members route.
export const memberRoleSchema = z.enum(["ADMIN", "MEMBER"]);

export const updateMemberRoleSchema = z.object({
  role: memberRoleSchema,
});

// Media caps per chat.md §8. `mimes` is a courtesy list for the file picker's
// `accept` attribute and the client-side pre-check only — the server decides
// from magic bytes (lib/media/sniff.ts), never from the declared type.
export const MEDIA_RULES = {
  image: {
    maxBytes: 5 * 1024 * 1024,
    mimes: ["image/jpeg", "image/png", "image/webp"],
  },
  video: {
    maxBytes: 20 * 1024 * 1024,
    mimes: ["video/mp4", "video/webm", "video/quicktime"],
  },
  file: {
    maxBytes: 10 * 1024 * 1024,
    mimes: ["application/pdf", "application/zip"],
  },
  // Voice notes. Recorder-only in v1 — deliberately NOT in the composer's file
  // picker ACCEPT (which lists the other three kinds explicitly), so these
  // mimes gate nothing today; the cap is what matters. 5MB fits a 2-minute
  // recording at any codec a MediaRecorder produces, with a wide margin.
  audio: {
    maxBytes: 5 * 1024 * 1024,
    mimes: ["audio/webm", "audio/mp4", "audio/ogg"],
  },
} as const;

export type MediaKind = keyof typeof MEDIA_RULES;

/** Voice-note recording cap. The recorder auto-stops here; the upload route
 *  re-checks Cloudinary's probed duration (plus jitter slack) on every AUDIO
 *  upload, so this bound holds even against a client that skips the recorder. */
export const VOICE_NOTE_MAX_MS = 2 * 60 * 1000;

/** Largest cap across kinds — the cheap `content-length` precheck before any parsing. */
export const MEDIA_MAX_BYTES = Math.max(...Object.values(MEDIA_RULES).map((rule) => rule.maxBytes));

export const HISTORY_PAGE_SIZE = 30;
export const HISTORY_MAX_PAGE_SIZE = 50;

/** The "Media, links & files" grid. Larger page than history — tiles are cheap. */
export const MEDIA_PAGE_SIZE = 40;

/**
 * Two characters, matching people-search. Below it the query is treated as
 * "nothing to search" and answered with an empty list and a 200, not a 400 —
 * search.md's own posture, and the client never sends one anyway.
 */
export const MESSAGE_SEARCH_MIN_LENGTH = 2;

/** Per-conversation state the owner can change. All optional, all independent. */
export const conversationStateSchema = z
  .object({
    pinned: z.boolean(),
    archived: z.boolean(),
    // Minutes from now, or null to unmute. 0 is rejected rather than treated as
    // "unmute" — the caller must say which it means.
    muteMinutes: z.number().int().positive().max(60 * 24 * 365).nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");

/**
 * "Clear chat" wipes your copy of the history; "delete" also drops the
 * conversation from your sidebar. Neither touches the other person's copy —
 * the route copy says so explicitly, because that is the one thing users get
 * wrong about this control.
 */
export const clearConversationSchema = z.object({
  mode: z.enum(["clear", "delete"]),
});

/**
 * Keyset cursor: "<epochMillis>.<messageId>".
 *
 * The tuple, not createdAt alone — statements inside one db.batch() share a
 * transaction and get an identical now(), so ties are real (a group's SYSTEM
 * message and its first real message can collide exactly). A bad cursor must
 * be a 400, not a silent fall back to page 1, which reads to the client as
 * "here's more" forever and loops the infinite scroll.
 */
export function parseMessageCursor(raw: string | null): { createdAt: Date; id: string } | null | "invalid" {
  if (raw === null || raw === "") return null;
  const separator = raw.indexOf(".");
  if (separator <= 0) return "invalid";
  const millis = Number(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (!Number.isSafeInteger(millis) || millis <= 0 || !id) return "invalid";
  return { createdAt: new Date(millis), id };
}

export function formatMessageCursor(createdAt: Date, id: string): string {
  return `${createdAt.getTime()}.${id}`;
}
