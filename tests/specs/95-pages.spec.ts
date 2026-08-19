import { describe, it, expect, beforeAll } from "vitest";
import { config } from "../src/env";
import { db, schema } from "../src/db";
import { createUser, createDirect, type FixtureUser } from "../src/fixtures";

/**
 * Page-render smoke: status codes and redirects, driven with and without a
 * session cookie. The load-bearing pin is /u/<missing> answering a HARD 404 —
 * CLAUDE.md documents that adding a loading.tsx beside that route silently
 * downgrades it to a streamed 200.
 */

let viewer: FixtureUser;
let other: FixtureUser;
let stranger: FixtureUser;
let conversationId: string;
let callId: string;

async function page(path: string, withSession: boolean) {
  const headers: Record<string, string> = { accept: "text/html" };
  if (withSession) headers.cookie = viewer.api.cookieHeader();
  return fetch(config.webUrl + path, { headers, redirect: "manual" });
}

describe("pages", () => {
  beforeAll(async () => {
    viewer = await createUser("pgv");
    other = await createUser("pgo");
    stranger = await createUser("pgs");
    conversationId = await createDirect(viewer, other);

    // A finished call for the /calls/[id] page, inserted directly — the page
    // renders from DB state alone. Explicit Dates, answered 5s in.
    callId = crypto.randomUUID();
    const startedAt = new Date(Date.now() - 10 * 60 * 1000);
    const answeredAt = new Date(startedAt.getTime() + 5 * 1000);
    const endedAt = new Date(startedAt.getTime() + 4 * 60 * 1000);
    await db.insert(schema.call).values({
      id: callId,
      conversationId,
      startedById: viewer.userId,
      kind: "AUDIO",
      status: "ENDED",
      startedAt,
      endedAt,
    });
    await db.insert(schema.callParticipant).values([
      { callId, userId: viewer.userId, joinedAt: startedAt, leftAt: endedAt },
      { callId, userId: other.userId, joinedAt: answeredAt, leftAt: endedAt },
    ]);
  });

  it.each(["/login", "/login/forgot-password", "/signup"])("%s renders publicly", async (path) => {
    const res = await page(path, false);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("/ is a doorway: to /login signed out, to /chats signed in", async () => {
    const anon = await page("/", false);
    expect([303, 307, 308]).toContain(anon.status);
    expect(anon.headers.get("location")).toContain("/login");

    const authed = await page("/", true);
    expect([303, 307, 308]).toContain(authed.status);
    expect(authed.headers.get("location")).toContain("/chats");
  });

  it.each([
    "/chats",
    "/search",
    "/calls",
    "/settings",
    "/settings/profile",
    "/settings/account",
    "/settings/privacy",
    "/settings/notifications",
    "/settings/appearance",
  ])("%s renders for a signed-in user", async (path) => {
    const res = await page(path, true);
    expect(res.status).toBe(200);
  });

  it("the conversation thread and public profile render", async () => {
    const thread = await page(`/chats/${conversationId}`, true);
    expect(thread.status).toBe(200);

    const profile = await page(`/u/${other.username}`, true);
    expect(profile.status).toBe(200);
    expect(await profile.text()).toContain(other.username);
  });

  it("the shell redirects signed-out visitors to /login", async () => {
    for (const path of ["/chats", "/settings", `/chats/${conversationId}`]) {
      const res = await page(path, false);
      expect([303, 307, 308], `${path} should redirect`).toContain(res.status);
      expect(res.headers.get("location")).toContain("/login");
    }
  });

  it("missing profile is a HARD 404 (the loading.tsx downgrade canary)", async () => {
    const res = await page("/u/zz.e2e.nosuchuser", true);
    expect(res.status).toBe(404);
  });

  it("the call detail page renders for a conversation member", async () => {
    const res = await page(`/calls/${callId}`, true);
    expect(res.status).toBe(200);
    // The §2.5 wording path (callStatusText → callBubbleText) actually ran.
    expect(await res.text()).toContain("Call ended");
  });

  it("call detail is a HARD 404 for non-members and unknown ids alike", async () => {
    // Same canary as /u/<missing>: a stray loading.tsx under calls/[id] would
    // stream this as a 200. Identical body for both cases — membership can't
    // be probed by status code or copy.
    const asStranger = await fetch(config.webUrl + `/calls/${callId}`, {
      headers: { accept: "text/html", cookie: stranger.api.cookieHeader() },
      redirect: "manual",
    });
    expect(asStranger.status).toBe(404);
    expect(await asStranger.text()).toContain("Call not found");

    const bogus = await page(`/calls/${crypto.randomUUID()}`, true);
    expect(bogus.status).toBe(404);
    expect(await bogus.text()).toContain("Call not found");
  });

  it("missing conversation and unknown routes 404", async () => {
    const missingThread = await page(`/chats/${crypto.randomUUID()}`, true);
    expect(missingThread.status).toBe(404);

    const nowhere = await page("/definitely/not/a/route", true);
    expect(nowhere.status).toBe(404);
  });
});
