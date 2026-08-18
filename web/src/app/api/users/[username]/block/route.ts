import { NextResponse } from "next/server";
import { and, eq } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { block, user } from "../../../../../../../db/schema";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * Block / unblock another user.
 *
 * Enforcement lives entirely on the server — the socket send handler, DM
 * creation and group-add all consult the `block` table. A client-side hide is
 * not a block, and this route only records the fact.
 *
 * Every failure answers with the same "User not found" as an unknown handle, so
 * the route never confirms whether a given account exists to someone probing.
 */
const BLOCK_LIMIT = { windowSeconds: 60 * 60, max: 60 };

const NOT_FOUND = { error: "User not found" };

async function resolve(username: string) {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.username, username.toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}

export async function POST(_request: Request, { params }: { params: Promise<{ username: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const withinLimit = await checkRateLimit(`block:${userId}`, BLOCK_LIMIT.windowSeconds, BLOCK_LIMIT.max);
  if (!withinLimit) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

  const { username } = await params;
  const target = await resolve(username);
  if (!target) return NextResponse.json(NOT_FOUND, { status: 404 });
  // Blocking yourself would make every one of your own sends fail the gate.
  if (target.id === userId) return NextResponse.json({ error: "You can't block yourself" }, { status: 400 });

  // onConflictDoNothing: the composite PK makes blocking idempotent, so a
  // double-tap is a no-op rather than a 23505 surfaced as a failure.
  await db
    .insert(block)
    .values({ blockerId: userId, blockedId: target.id })
    .onConflictDoNothing();

  return NextResponse.json({ success: true, blocked: true });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ username: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const withinLimit = await checkRateLimit(`block:${userId}`, BLOCK_LIMIT.windowSeconds, BLOCK_LIMIT.max);
  if (!withinLimit) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

  const { username } = await params;
  const target = await resolve(username);
  if (!target) return NextResponse.json(NOT_FOUND, { status: 404 });

  // No returning()/404 on zero rows: unblocking someone you never blocked is
  // already the state the caller asked for.
  await db
    .delete(block)
    .where(and(eq(block.blockerId, userId), eq(block.blockedId, target.id)));

  return NextResponse.json({ success: true, blocked: false });
}
