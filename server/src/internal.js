const express = require("express");
const { timingSafeEqual } = require("node:crypto");
const { env } = require("./env");
const {
  joinUsersToConversation,
  removeUsersFromConversation,
} = require("./rooms");
const notify = require("./handlers/notify");

/**
 * The web -> socket hook.
 *
 * Rooms are joined once, at connect, from a server-side SELECT. So a group you
 * were just added to reaches you not at all until a reload, because the route
 * that added you runs in a different process. chat.md's §2.1 diagram joins
 * rooms once and never revisits this; that gap is what this router closes.
 *
 * Deliberately a **closed set of event kinds** rather than a generic
 * { room, event, payload } RPC: this server maps kind -> room + event itself,
 * so a leaked INTERNAL_API_SECRET buys only these effects instead of "emit
 * anything to anyone". Bind it to a private interface in production too.
 */

function secretMatches(given) {
  if (!env.INTERNAL_API_SECRET || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(env.INTERNAL_API_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

function internalRouter(getIo) {
  const router = express.Router();

  router.post("/events", (req, res) => {
    if (!secretMatches(req.get("x-internal-secret"))) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const io = getIo();
    const event = req.body;
    if (!event || typeof event.kind !== "string") {
      return res.status(400).json({ error: "Invalid request" });
    }

    const { conversationId } = event;
    if (typeof conversationId !== "string")
      return res.status(400).json({ error: "Invalid request" });

    switch (event.kind) {
      case "conversation.created":
      case "members.added": {
        const userIds = Array.isArray(event.userIds)
          ? event.userIds.filter((id) => typeof id === "string")
          : [];
        joinUsersToConversation(io, userIds, conversationId);
        // No summary is shipped: the client refetches its list, which is always
        // correct and avoids duplicating the four-query shape over here.
        notify.toUsers(io, userIds, "conversation:added", { conversationId });
        if (event.kind === "members.added") {
          notify.toConversation(io, conversationId, "conversation:updated", {
            conversationId,
          });
        }
        break;
      }
      case "members.removed": {
        const userIds = Array.isArray(event.userIds)
          ? event.userIds.filter((id) => typeof id === "string")
          : [];
        // Tell them first, then take the room away — the other order means the
        // notification is emitted into a room they are no longer in.
        notify.toUsers(io, userIds, "conversation:removed", {
          conversationId,
          reason: "REMOVED",
        });
        removeUsersFromConversation(io, userIds, conversationId);
        notify.toConversation(io, conversationId, "conversation:updated", {
          conversationId,
        });
        break;
      }
      case "conversation.updated": {
        notify.toConversation(io, conversationId, "conversation:updated", {
          conversationId,
          name: event.name ?? null,
          avatarUrl: event.avatarUrl ?? null,
        });
        break;
      }
      case "conversation.read": {
        // The HTTP read route's counterpart to the socket handler's read-sync:
        // to the reader's own tabs only, never the conversation room.
        if (typeof event.userId === "string") {
          notify.toUsers(io, [event.userId], "conversation:read-sync", {
            conversationId,
            lastReadAt:
              typeof event.lastReadAt === "string" ? event.lastReadAt : null,
          });
        }
        break;
      }
      case "message.created": {
        if (event.message) {
          notify.toConversation(io, conversationId, "message:new", {
            conversationId,
            message: event.message,
          });
        }
        break;
      }
      // One member's own view of a conversation changed (pin / mute / archive /
      // clear / delete). Their own tabs only — routing it to the conversation
      // room would tell the other members that you muted or deleted the chat.
      case "conversation.self-changed": {
        if (typeof event.userId === "string") {
          notify.toUsers(io, [event.userId], "conversation:self-changed", { conversationId });
        }
        break;
      }

      default:
        return res.status(400).json({ error: "Unknown event kind" });
    }

    return res.json({ ok: true });
  });

  return router;
}

module.exports = { internalRouter };
