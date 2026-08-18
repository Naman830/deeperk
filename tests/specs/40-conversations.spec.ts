import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { createUser, type FixtureUser } from "../src/fixtures";
import { connectAs, emitWithAck, closeAllSockets } from "../src/socket";

/**
 * Conversation lifecycle over REST: direct/group creation, the sidebar list,
 * detail + probe resistance, rename, per-user clear/delete, pin/mute/archive,
 * read watermark, group membership admin, forward, and chat-media upload.
 * Sockets are used only where REST has no send path (seeding messages).
 */

// sharp is hoisted to the repo root; resolve it the way web/ itself would.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sharp: any = createRequire(new URL("../../web/package.json", import.meta.url))("sharp");

/** Always-present keys of one sidebar summary (listConversations). otherUser is DM-only. */
const DM_SUMMARY_FIELDS = [
  "archivedAt",
  "avatarUrl",
  "id",
  "lastMessage",
  "lastReadAt",
  "memberCount",
  "mutedUntil",
  "name",
  "otherUser",
  "pinnedAt",
  "role",
  "type",
  "unreadCount",
  "updatedAt",
];

let alice: FixtureUser; // owner/actor for most flows
let bob: FixtureUser; // DM counterpart, plain group MEMBER
let cara: FixtureUser; // third wheel: non-member probes, add/remove target
let dmId: string;
let groupId: string;

function mediaForm(bytes: Uint8Array, conversationId: string, name: string): FormData {
  const form = new FormData();
  // Copy: a Buffer types as Uint8Array<ArrayBufferLike>, which BlobPart rejects.
  form.append("file", new File([new Uint8Array(bytes)], name, { type: "image/png" }), name);
  form.append("conversationId", conversationId);
  return form;
}

describe("conversations", () => {
  beforeAll(async () => {
    alice = await createUser("cva");
    bob = await createUser("cvb");
    cara = await createUser("cvc");
  });

  afterAll(() => closeAllSockets());

  describe("direct", () => {
    it("creates a DM: 201 with created:true", async () => {
      const res = await alice.api.post("/api/conversations/direct", { json: { username: bob.username } });
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(true);
      expect(typeof res.body.conversationId).toBe("string");
      dmId = res.body.conversationId;
    });

    it("repeat is a reopen: 200, created:false, same id", async () => {
      const res = await alice.api.post("/api/conversations/direct", { json: { username: bob.username } });
      expect(res.status).toBe(200);
      expect(res.body.created).toBe(false);
      expect(res.body.conversationId).toBe(dmId);
    });

    it("self-DM is a 400", async () => {
      const res = await alice.api.post("/api/conversations/direct", { json: { username: alice.username } });
      expect(res.status).toBe(400);
    });

    it("unknown username is a 404 with the non-committal body", async () => {
      const res = await alice.api.post("/api/conversations/direct", { json: { username: "zz.e2e.ghostcv" } });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "User not found" });
    });
  });

  describe("group", () => {
    it("creates a group: 201 with conversationId", async () => {
      const res = await alice.api.post("/api/conversations/group", {
        json: { name: "cv harness group", memberUsernames: [bob.username] },
      });
      expect(res.status).toBe(201);
      expect(typeof res.body.conversationId).toBe("string");
      groupId = res.body.conversationId;
    });

    it("rejects an empty member list with 400", async () => {
      const res = await alice.api.post("/api/conversations/group", {
        json: { name: "cv empty group", memberUsernames: [] },
      });
      expect(res.status).toBe(400);
    });

    it("detail shows the creator as OWNER in the members array", async () => {
      const res = await alice.api.get(`/api/conversations/${groupId}`);
      expect(res.status).toBe(200);
      expect(res.body.role).toBe("OWNER");
      expect(Array.isArray(res.body.members)).toBe(true);
      expect(res.body.members).toHaveLength(2);
      const creator = res.body.members.find((member: { id: string }) => member.id === alice.userId);
      expect(creator?.role).toBe("OWNER");
      const member = res.body.members.find((member: { id: string }) => member.id === bob.userId);
      expect(member?.role).toBe("MEMBER");
    });
  });

  describe("list", () => {
    it("contains both conversations and pins the summary key set", async () => {
      const res = await alice.api.get("/api/conversations");
      expect(res.status).toBe(200);
      const ids = res.body.conversations.map((summary: { id: string }) => summary.id);
      expect(ids).toContain(dmId);
      expect(ids).toContain(groupId);
      expect(res.body.nextCursor).toBeNull();

      const dm = res.body.conversations.find((summary: { id: string }) => summary.id === dmId);
      expect(Object.keys(dm).sort()).toEqual(DM_SUMMARY_FIELDS);
      expect(dm.type).toBe("DIRECT");
      expect(dm.unreadCount).toBe(0);
      expect(dm.otherUser.username).toBe(bob.username);

      const group = res.body.conversations.find((summary: { id: string }) => summary.id === groupId);
      // otherUser is the one DM-only key; a group summary has all the rest.
      expect(Object.keys(group).sort()).toEqual(DM_SUMMARY_FIELDS.filter((key) => key !== "otherUser"));
      expect(group.lastMessage?.type).toBe("SYSTEM");
    });
  });

  describe("detail probe resistance", () => {
    it("non-member and nonexistent id answer identically", async () => {
      const asNonMember = await cara.api.get(`/api/conversations/${dmId}`);
      const asNonsense = await cara.api.get(`/api/conversations/${crypto.randomUUID()}`);
      expect(asNonMember.status).toBe(404);
      expect(asNonsense.status).toBe(404);
      expect(asNonMember.body).toEqual(asNonsense.body);
    });
  });

  describe("state (pin / mute / archive)", () => {
    it("rejects an empty patch and a zero mute", async () => {
      const empty = await alice.api.patch(`/api/conversations/${dmId}/state`, { json: {} });
      expect(empty.status).toBe(400);
      // 0 must not mean "unmute" — the schema demands a positive int or null.
      const zero = await alice.api.patch(`/api/conversations/${dmId}/state`, { json: { muteMinutes: 0 } });
      expect(zero.status).toBe(400);
    });

    it("sets all three, reads them back on detail, then clears them", async () => {
      const set = await alice.api.patch(`/api/conversations/${dmId}/state`, {
        json: { pinned: true, archived: true, muteMinutes: 120 },
      });
      expect(set.status).toBe(200);
      expect(set.body.success).toBe(true);
      expect(set.body.pinnedAt).not.toBeNull();
      expect(set.body.archivedAt).not.toBeNull();
      const mutedUntil = Date.parse(set.body.mutedUntil);
      expect(mutedUntil).toBeGreaterThan(Date.now() + 90 * 60_000);
      expect(mutedUntil).toBeLessThan(Date.now() + 150 * 60_000);

      const detail = await alice.api.get(`/api/conversations/${dmId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.pinnedAt).toBe(set.body.pinnedAt);
      expect(detail.body.mutedUntil).toBe(set.body.mutedUntil);
      expect(detail.body.archivedAt).toBe(set.body.archivedAt);

      const clear = await alice.api.patch(`/api/conversations/${dmId}/state`, {
        json: { pinned: false, archived: false, muteMinutes: null },
      });
      expect(clear.status).toBe(200);
      expect(clear.body.pinnedAt).toBeNull();
      expect(clear.body.mutedUntil).toBeNull();
      expect(clear.body.archivedAt).toBeNull();
    });

    it("404s for a non-member", async () => {
      const res = await cara.api.patch(`/api/conversations/${dmId}/state`, { json: { pinned: true } });
      expect(res.status).toBe(404);
    });
  });

  describe("read watermark", () => {
    it("returns lastReadAt and never regresses", async () => {
      const first = await alice.api.post(`/api/conversations/${dmId}/read`);
      expect(first.status).toBe(200);
      expect(first.body.success).toBe(true);
      expect(typeof first.body.lastReadAt).toBe("string");

      const second = await alice.api.post(`/api/conversations/${dmId}/read`);
      expect(second.status).toBe(200);
      expect(Date.parse(second.body.lastReadAt)).toBeGreaterThanOrEqual(Date.parse(first.body.lastReadAt));
    });
  });

  describe("rename", () => {
    it("owner renames the group", async () => {
      const res = await alice.api.patch(`/api/conversations/${groupId}`, { json: { name: "cv renamed group" } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, name: "cv renamed group" });
    });

    it("plain member gets 403", async () => {
      const res = await bob.api.patch(`/api/conversations/${groupId}`, { json: { name: "cv hijacked" } });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Only group admins can do that");
    });
  });

  describe("clear and delete (per-user, never global)", () => {
    beforeAll(async () => {
      // Seed the DM: the clear needs history to hide.
      const bobSocket = await connectAs(bob.api);
      const ack = await emitWithAck(bobSocket.socket, "message:send", {
        conversationId: dmId,
        clientMsgId: crypto.randomUUID(),
        type: "TEXT",
        text: "cv hello before clear",
      });
      expect(ack.ok).toBe(true);
    });

    it("rejects an unknown mode", async () => {
      const res = await alice.api.del(`/api/conversations/${dmId}`, { json: { mode: "nuke" } });
      expect(res.status).toBe(400);
    });

    it("clear empties the actor's history and leaves the other member's intact", async () => {
      const res = await alice.api.del(`/api/conversations/${dmId}`, { json: { mode: "clear" } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, mode: "clear" });

      const mine = await alice.api.get(`/api/conversations/${dmId}/messages`);
      expect(mine.status).toBe(200);
      expect(mine.body.messages).toEqual([]);

      const theirs = await bob.api.get(`/api/conversations/${dmId}/messages`);
      expect(theirs.status).toBe(200);
      expect(
        theirs.body.messages.some((message: { body: string | null }) => message.body === "cv hello before clear"),
      ).toBe(true);
    });

    it("delete drops it from the actor's sidebar only", async () => {
      const res = await alice.api.del(`/api/conversations/${dmId}`, { json: { mode: "delete" } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, mode: "delete" });

      const mine = await alice.api.get("/api/conversations");
      expect(mine.body.conversations.map((summary: { id: string }) => summary.id)).not.toContain(dmId);

      const theirs = await bob.api.get("/api/conversations");
      expect(theirs.body.conversations.map((summary: { id: string }) => summary.id)).toContain(dmId);
    });
  });

  describe("members", () => {
    it("plain member cannot add people: 403", async () => {
      const res = await bob.api.post(`/api/conversations/${groupId}/members`, {
        json: { usernames: [cara.username] },
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Only group admins can add people");
    });

    it("owner adds a member: 201, and they can now read the detail", async () => {
      const res = await alice.api.post(`/api/conversations/${groupId}/members`, {
        json: { usernames: [cara.username] },
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ success: true, added: 1 });

      const detail = await cara.api.get(`/api/conversations/${groupId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.members).toHaveLength(3);
    });

    it("owner promotes the new member to ADMIN", async () => {
      const res = await alice.api.patch(`/api/conversations/${groupId}/members/${cara.userId}`, {
        json: { role: "ADMIN" },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, role: "ADMIN" });
    });

    it("removal locks the removed member out with a 404", async () => {
      const res = await alice.api.del(`/api/conversations/${groupId}/members/${cara.userId}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });

      const detail = await cara.api.get(`/api/conversations/${groupId}`);
      expect(detail.status).toBe(404);
    });
  });

  describe("forward", () => {
    let forwardSourceId: string;

    beforeAll(async () => {
      const aliceSocket = await connectAs(alice.api);
      const ack = await emitWithAck(aliceSocket.socket, "message:send", {
        conversationId: dmId,
        clientMsgId: crypto.randomUUID(),
        type: "TEXT",
        text: "cv forward source",
      });
      expect(ack.ok).toBe(true);
      forwardSourceId = ack.message.id;
    });

    it("forwards a TEXT message from the DM into the group", async () => {
      const res = await alice.api.post(`/api/conversations/${groupId}/forward`, {
        json: { messageIds: [forwardSourceId] },
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.messages).toHaveLength(1);
      const forwarded = res.body.messages[0];
      // A copy, not the original row.
      expect(forwarded.id).not.toBe(forwardSourceId);
      expect(forwarded.conversationId).toBe(groupId);
      expect(forwarded.senderId).toBe(alice.userId);
      expect(forwarded.body).toBe("cv forward source");

      const history = await alice.api.get(`/api/conversations/${groupId}/messages`);
      expect(history.status).toBe(200);
      expect(history.body.messages.some((message: { id: string }) => message.id === forwarded.id)).toBe(true);
    });

    it("forwarding into a conversation you are not in is a 404", async () => {
      // cara was removed from the group above — the destination check fires first.
      const res = await cara.api.post(`/api/conversations/${groupId}/forward`, {
        json: { messageIds: [forwardSourceId] },
      });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Conversation not found" });
    });
  });

  describe("chat media upload + media list", () => {
    let png: Uint8Array;
    let upload: { mediaUrl: string; mediaToken: string };

    beforeAll(async () => {
      png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 210, g: 60, b: 90 } } })
        .png()
        .toBuffer();
    });

    it("uploads a PNG: 201 with mediaToken + mediaUrl", async () => {
      const res = await alice.api.post("/api/upload/chat-media", { form: mediaForm(png, dmId, "pixel.png") });
      expect(res.status).toBe(201);
      expect(res.body.type).toBe("IMAGE");
      expect(res.body.mediaMime).toBe("image/png");
      expect(res.body.mediaSize).toBe(png.byteLength);
      expect(res.body.mediaName).toBe("pixel.png");
      expect(typeof res.body.mediaToken).toBe("string");
      expect(res.body.mediaUrl).toMatch(/^https?:\/\//);
      upload = res.body;
    });

    it("non-member conversationId is a 404", async () => {
      const res = await cara.api.post("/api/upload/chat-media", { form: mediaForm(png, dmId, "pixel.png") });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Conversation not found" });
    });

    it("junk bytes fail the magic-byte sniff with 400", async () => {
      const junk = new TextEncoder().encode("cv definitely not an image, just words padded out a bit");
      const res = await alice.api.post("/api/upload/chat-media", { form: mediaForm(junk, dmId, "junk.png") });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "That file type isn't supported" });
    });

    it("the sent image appears in the conversation media list", async () => {
      const aliceSocket = await connectAs(alice.api);
      const ack = await emitWithAck(aliceSocket.socket, "message:send", {
        conversationId: dmId,
        clientMsgId: crypto.randomUUID(),
        type: "IMAGE",
        mediaToken: upload.mediaToken,
      });
      expect(ack.ok).toBe(true);
      expect(ack.message.type).toBe("IMAGE");
      expect(ack.message.mediaUrl).toBe(upload.mediaUrl);
      // Intrinsic dimensions ride the token from sharp's metadata() at upload.
      expect(ack.message.mediaWidth).toBe(64);
      expect(ack.message.mediaHeight).toBe(64);

      const media = await alice.api.get(`/api/conversations/${dmId}/media`);
      expect(media.status).toBe(200);
      expect(media.body.hasMore).toBe(false);
      expect(media.body.messages.some((message: { id: string }) => message.id === ack.message.id)).toBe(true);
    });
  });
});
