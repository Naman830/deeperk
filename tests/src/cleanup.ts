import { db, schema, ops } from "./db";
import { config } from "./env";
import { USERNAME_PREFIX } from "./fixtures";

const { like, inArray, or, eq } = ops;

/**
 * DELIBERATE EXCEPTION to the repo rule "never hard-delete a `user` row".
 *
 * That rule protects real history, which assumes users persist. Fixture users
 * are self-contained — every message/conversation/block they touch is between
 * fixture users — so deleting them dangles nothing. The alternative (keep and
 * deactivate) grows the real DB with junk on every run.
 *
 * Guardrails: only rows reachable from a `zz.e2e.%` username are ever touched,
 * and the neon-http driver has no transactions, so the order below is what
 * satisfies every ON DELETE RESTRICT — do not reorder:
 *   message_deletion/message/conversation_member RESTRICT to user;
 *   call_participant (user_id) and call (started_by_id) RESTRICT to user too —
 *   deleted before user; message.call_id is SET NULL so call-vs-message order
 *   is free; conversation CASCADEs its own members+messages+calls;
 *   block RESTRICTs both ways;
 *   account/session/privacy_settings/social_link/pending_contact_change
 *   CASCADE from user at the end.
 *
 * Idempotent, and also run at globalSetup to sweep a crashed prior run.
 */
export async function cleanupAll(): Promise<void> {
  const users = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(like(schema.user.username, `${USERNAME_PREFIX}%`));
  const userIds: string[] = users.map((row: { id: string }) => row.id);

  if (userIds.length > 0) {
    const conversations = await db
      .select({ id: schema.conversation.id })
      .from(schema.conversation)
      .where(inArray(schema.conversation.createdById, userIds));
    const conversationIds: string[] = conversations.map((row: { id: string }) => row.id);

    await db.delete(schema.messageDeletion).where(inArray(schema.messageDeletion.userId, userIds));
    await db.delete(schema.message).where(inArray(schema.message.senderId, userIds));
    await db.delete(schema.callParticipant).where(inArray(schema.callParticipant.userId, userIds));
    await db.delete(schema.call).where(inArray(schema.call.startedById, userIds));
    await db.delete(schema.conversationMember).where(inArray(schema.conversationMember.userId, userIds));
    if (conversationIds.length > 0) {
      await db.delete(schema.conversation).where(inArray(schema.conversation.id, conversationIds));
    }
    await db
      .delete(schema.block)
      .where(or(inArray(schema.block.blockerId, userIds), inArray(schema.block.blockedId, userIds)));
    await db.delete(schema.reservedUsername).where(inArray(schema.reservedUsername.userId, userIds));
    for (const id of userIds) {
      await db.delete(schema.rateLimitHit).where(like(schema.rateLimitHit.bucketKey, `%${id}%`));
    }
    await db.delete(schema.user).where(inArray(schema.user.id, userIds));
  }

  await db
    .delete(schema.pendingRegistration)
    .where(like(schema.pendingRegistration.email, `${USERNAME_PREFIX}%`));
  await db.delete(schema.rateLimitHit).where(like(schema.rateLimitHit.bucketKey, `%${USERNAME_PREFIX}%`));
  // Any bucket keyed by a TEST-NET-3 source IP came from this harness.
  await db.delete(schema.rateLimitHit).where(like(schema.rateLimitHit.bucketKey, `%203.0.113.%`));

  if (config.testEmail && config.testEmail.includes("@")) {
    const [local, domain] = config.testEmail.split("@");
    await db
      .delete(schema.pendingRegistration)
      .where(like(schema.pendingRegistration.email, `${local}+%@${domain}`));
    // A prior aborted run may have completed a signup for a plus-addressed user.
    const strays = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(like(schema.user.email, `${local}+%@${domain}`));
    const strayIds: string[] = strays.map((row: { id: string }) => row.id);
    if (strayIds.length > 0) {
      await db.delete(schema.messageDeletion).where(inArray(schema.messageDeletion.userId, strayIds));
      await db.delete(schema.message).where(inArray(schema.message.senderId, strayIds));
      await db.delete(schema.callParticipant).where(inArray(schema.callParticipant.userId, strayIds));
      await db.delete(schema.call).where(inArray(schema.call.startedById, strayIds));
      await db.delete(schema.conversationMember).where(inArray(schema.conversationMember.userId, strayIds));
      await db.delete(schema.reservedUsername).where(inArray(schema.reservedUsername.userId, strayIds));
      await db.delete(schema.user).where(inArray(schema.user.id, strayIds));
    }
  }
}

/** How many fixture rows remain — the cleanup drill asserts this hits zero. */
export async function countLeftovers(): Promise<number> {
  const rows = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(like(schema.user.username, `${USERNAME_PREFIX}%`));
  return rows.length;
}

/** Seed a DB-backed rate bucket to its cap so ONE request deterministically 429s. */
export async function seedRateLimit(bucketKey: string, count: number): Promise<void> {
  await db
    .insert(schema.rateLimitHit)
    .values({ bucketKey, windowStart: new Date(), count })
    .onConflictDoUpdate({
      target: schema.rateLimitHit.bucketKey,
      set: { windowStart: new Date(), count },
    });
}

export { eq };
