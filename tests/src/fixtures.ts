import { randomBytes } from "node:crypto";
import { ApiClient } from "./api";

/**
 * Fixture identity scheme (see tests/README.md for the cleanup contract):
 * - usernames:  zz.e2e.<tag><run><n>   — valid per the app's username pattern,
 *   lowercase, no reserved-word collisions, sorts last in any listing.
 * - emails:     <username>@deeperk-e2e.test — RFC 6761 reserved TLD, so
 *   even a bug can never send it real mail. Only the deliberately-mailing
 *   flows use TEST_EMAIL.
 * - Creation goes through Better Auth's own POST /api/auth/sign-up/email:
 *   sends no email, stamps emailVerified via the databaseHook, auto-signs-in
 *   (cookie lands in the jar), and is NOT covered by the signup-create 3/hr
 *   cap (that guards only the custom /api/signup/complete route).
 */
export const RUN_ID = randomBytes(3).toString("hex");
export const PASSWORD = "E2eHarness.1234";
export const USERNAME_PREFIX = "zz.e2e.";

/** Per-run source IP from TEST-NET-3 so IP-keyed buckets never span runs. */
export const RUN_XFF = `203.0.113.${(parseInt(RUN_ID.slice(0, 2), 16) % 200) + 10}`;

let counter = 0;

export type FixtureUser = {
  api: ApiClient;
  userId: string;
  username: string;
  email: string;
  tag: string;
};

export function newApi(): ApiClient {
  return new ApiClient({ xff: RUN_XFF });
}

export async function createUser(rawTag: string): Promise<FixtureUser> {
  const tag = rawTag.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "u";
  const username = `${USERNAME_PREFIX}${tag}${RUN_ID}${(counter++).toString(36)}`;
  const email = `${username}@deeperk-e2e.test`;
  const api = newApi();
  const res = await api.post("/api/auth/sign-up/email", {
    json: {
      name: `E2E ${tag}`,
      email,
      password: PASSWORD,
      username,
      firstName: "E2e",
      lastName: tag,
      birthDate: "2000-01-15",
    },
  });
  if (res.status >= 400 || !res.body?.user?.id) {
    throw new Error(`fixture signup failed (${res.status}): ${res.text.slice(0, 300)}`);
  }
  if (!api.hasSession()) {
    throw new Error("fixture signup returned no session cookie — auto-sign-in broke");
  }
  return { api, userId: res.body.user.id, username, email, tag };
}

export async function createDirect(a: FixtureUser, b: FixtureUser): Promise<string> {
  const res = await a.api.post("/api/conversations/direct", { json: { username: b.username } });
  if (res.status >= 400 || !res.body?.conversationId) {
    throw new Error(`createDirect failed (${res.status}): ${res.text.slice(0, 300)}`);
  }
  return res.body.conversationId as string;
}

export async function createGroup(owner: FixtureUser, members: FixtureUser[], name: string): Promise<string> {
  const res = await owner.api.post("/api/conversations/group", {
    json: { name, memberUsernames: members.map((member) => member.username) },
  });
  if (res.status >= 400 || !res.body?.conversationId) {
    throw new Error(`createGroup failed (${res.status}): ${res.text.slice(0, 300)}`);
  }
  return res.body.conversationId as string;
}
