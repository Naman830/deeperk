const { db, schema, ops } = require("../../config/db");

const { conversation, conversationMember, user } = schema;
const { eq } = ops;

// User ids are Better Auth's own 32-char base62, NOT this app's UUIDs — a
// UUID-shape check on rtc:signal's `to` rejects every real signal.
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CALL_KINDS = new Set(["AUDIO", "VIDEO"]);
const MAX_JOINED = 4; // mesh cap (call.md)

const INVALID = { code: "INVALID", error: "Invalid request." };
// One answer for "no such call" and "not yours to touch" — same probing rule
// as the chat controller's NOT_FOUND. Terminal calls are removed from memory,
// so a late accept/reject lands here too.
const NOT_FOUND = { code: "NOT_FOUND", error: "Call not found." };
const CONVERSATION_NOT_FOUND = { code: "NOT_FOUND", error: "Conversation not found." };
// Byte-identical to CONVERSATION_NOT_FOUND on purpose: a differing string
// would let a caller distinguish "blocked" from "no such conversation".
const BLOCKED = { code: "NOT_FOUND", error: "Conversation not found." };

// CALL_ACTIVE carries the existing call so the client pivots to accept/join it.
function failCallActive(ack, record) {
  if (typeof ack === "function") {
    ack({
      ok: false,
      code: "CALL_ACTIVE",
      error: "A call is already active in this conversation.",
      callId: record.id,
      kind: record.kind,
    });
  }
}

// Conversation type/name + member display fields in one query — the CallUser
// enrichment source for ring payloads and acks. null when the conversation
// doesn't exist.
async function listMembers(conversationId) {
  const rows = await db
    .select({
      type: conversation.type,
      name: conversation.name,
      id: user.id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarPublicId: user.avatarPublicId,
    })
    .from(conversationMember)
    .innerJoin(conversation, eq(conversation.id, conversationMember.conversationId))
    .innerJoin(user, eq(user.id, conversationMember.userId))
    .where(eq(conversationMember.conversationId, conversationId));
  if (rows.length === 0) return null;
  return {
    type: rows[0].type,
    name: rows[0].name,
    members: rows.map(toCallUser),
  };
}

function toCallUser(m) {
  return {
    id: m.id,
    username: m.username,
    firstName: m.firstName,
    lastName: m.lastName,
    avatarPublicId: m.avatarPublicId,
  };
}

function endsWithoutUser(record, joinedRemaining) {
  // DIRECT ends below 2 joined; a lone GROUP participant keeps the call.
  return record.conversationType === "DIRECT" ? joinedRemaining < 2 : joinedRemaining === 0;
}

module.exports = {
  USER_ID_PATTERN,
  CALL_KINDS,
  MAX_JOINED,
  INVALID,
  NOT_FOUND,
  CONVERSATION_NOT_FOUND,
  BLOCKED,
  failCallActive,
  listMembers,
  toCallUser,
  endsWithoutUser,
};
