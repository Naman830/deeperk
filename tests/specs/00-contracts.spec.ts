import { describe, it, expect, afterAll, inject } from "vitest";
import { config } from "../src/env";
import { db, ops } from "../src/db";
import { createUser, createDirect } from "../src/fixtures";
import { connectAs, waitFor, emitWithAck, closeAllSockets } from "../src/socket";

/**
 * Runs first. Proves the ground the whole suite stands on: the schema is
 * actually pushed (nothing in-tree can prove drizzle-kit push ran), the
 * socket server is the same process healthz reported at setup, and the REST
 * and socket representations of a message are the same wire contract.
 */

const EXPECTED_TABLES = [
  "account",
  "block",
  "call",
  "call_participant",
  "conversation",
  "conversation_member",
  "message",
  "message_deletion",
  "pending_contact_change",
  "pending_registration",
  "privacy_settings",
  "rate_limit_hit",
  "reserved_username",
  "session",
  "social_link",
  "user",
  "verification",
];

/** The 17 fields serialize() (server) and toChatMessage (web) both emit. */
const MESSAGE_FIELDS = [
  "body",
  "callId",
  "clientMsgId",
  "conversationId",
  "createdAt",
  "deletedAt",
  "editedAt",
  "id",
  "mediaHeight",
  "mediaMime",
  "mediaName",
  "mediaSize",
  "mediaUrl",
  "mediaWidth",
  "replyToId",
  "senderId",
  "type",
];

describe("contracts", () => {
  afterAll(() => closeAllSockets());

  it("all expected tables exist in the pushed schema", async () => {
    const result = await db.execute(
      ops.sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = result.rows.map((row: { table_name: string }) => row.table_name);
    for (const table of EXPECTED_TABLES) {
      expect(names, `missing table ${table}`).toContain(table);
    }
  });

  it("healthz answers with the bootId captured at suite start", async () => {
    const health = await fetch(`${config.socketUrl}/healthz`).then((res) => res.json());
    expect(health.ok).toBe(true);
    expect(typeof health.uptime).toBe("number");
    expect(health.bootId).toBe(inject("bootId"));
  });

  it("REST and socket agree on the message wire contract, field for field", async () => {
    const alice = await createUser("ctra");
    const bob = await createUser("ctrb");
    const conversationId = await createDirect(alice, bob);

    const aliceSocket = await connectAs(alice.api);
    const bobSocket = await connectAs(bob.api);
    expect(aliceSocket.bootId).toBe(inject("bootId"));

    const clientMsgId = crypto.randomUUID();
    const broadcastPromise = waitFor<{ message: Record<string, unknown> }>(
      bobSocket.socket,
      "message:new",
      (payload) => payload.message?.clientMsgId === clientMsgId,
    );
    const ack = await emitWithAck(aliceSocket.socket, "message:send", {
      conversationId,
      clientMsgId,
      type: "TEXT",
      text: "contract pin",
    });
    expect(ack.ok).toBe(true);
    const broadcast = await broadcastPromise;

    const rest = await alice.api.get(`/api/conversations/${conversationId}/messages`);
    expect(rest.status).toBe(200);
    const restMessage = rest.body.messages.find(
      (message: { clientMsgId?: string }) => message.clientMsgId === clientMsgId,
    );
    expect(restMessage, "sent message missing from REST history").toBeTruthy();

    // The pin: identical sorted key sets on ack, broadcast, and REST...
    expect(Object.keys(ack.message).sort()).toEqual(MESSAGE_FIELDS);
    expect(Object.keys(broadcast.message).sort()).toEqual(MESSAGE_FIELDS);
    expect(Object.keys(restMessage).sort()).toEqual(MESSAGE_FIELDS);
    // ...and identical values, not just shapes.
    expect(restMessage).toEqual(ack.message);
    expect(broadcast.message).toEqual(ack.message);
  });
});
