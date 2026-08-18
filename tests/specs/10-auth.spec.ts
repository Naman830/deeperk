import { describe, it, expect, beforeAll } from "vitest";
import { config } from "../src/env";
import { db, schema, ops } from "../src/db";
import { createUser, newApi, PASSWORD, RUN_ID, USERNAME_PREFIX, type FixtureUser } from "../src/fixtures";
import { readSignupOtp } from "../src/otp";

/**
 * Auth surface: Better Auth's origin gate and sign-in behavior, the custom
 * multi-step signup routes, and — when TEST_EMAIL is set — the run's ONE real
 * Brevo send driving the full OTP signup end to end.
 */

let fixture: FixtureUser;

describe("auth", () => {
  beforeAll(async () => {
    fixture = await createUser("au");
  });

  it("sign-in with no Origin header is a 403 MISSING_OR_NULL_ORIGIN", async () => {
    const res = await newApi().post("/api/auth/sign-in/email", {
      json: { email: `zz.e2e.auorigin${RUN_ID}@chatsphere-e2e.test`, password: PASSWORD },
      origin: null,
    });
    expect(res.status).toBe(403);
    // Pin the code, not just the status — a 403 for any other reason (CSRF,
    // untrusted origin) must not let this negative pass for the wrong reason.
    expect(res.body?.code).toBe("MISSING_OR_NULL_ORIGIN");
    expect(res.text).toMatch(/origin/i);
  });

  it("unknown email and wrong password answer identically (anti-enumeration)", async () => {
    const unknown = await newApi().post("/api/auth/sign-in/email", {
      json: { email: `zz.e2e.aughost${RUN_ID}@chatsphere-e2e.test`, password: "Wrong.password123" },
    });
    const wrongPassword = await newApi().post("/api/auth/sign-in/email", {
      json: { email: fixture.email, password: "Wrong.password123" },
    });

    expect(unknown.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    // Pin the code so "identical" can't be two matching unrelated failures...
    expect(unknown.body?.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    // ...and require the full bodies to match, not just the code.
    expect(wrongPassword.body).toEqual(unknown.body);
  });

  it("sign-in happy path: session cookie, get-session, sign-out", async () => {
    const api = newApi();
    const signIn = await api.post("/api/auth/sign-in/email", {
      json: { email: fixture.email, password: PASSWORD },
    });
    expect(signIn.status, signIn.text).toBe(200);
    expect(signIn.body?.user?.id).toBe(fixture.userId);
    expect(api.hasSession()).toBe(true);

    const session = await api.get("/api/auth/get-session");
    expect(session.status).toBe(200);
    expect(session.body?.user?.id).toBe(fixture.userId);
    expect(session.body?.user?.email).toBe(fixture.email);

    // Better Auth's POST endpoints 415 a body-less request — send empty JSON.
    const signOut = await api.post("/api/auth/sign-out", { json: {} });
    expect(signOut.status).toBe(200);
    expect(signOut.body).toEqual({ success: true });
    expect(api.hasSession()).toBe(false);

    const after = await api.get("/api/auth/get-session");
    expect(after.status).toBe(200);
    expect(after.body).toBeNull();
  });

  it("check-email: fresh address is available, fixture email is taken", async () => {
    const api = newApi();
    const freshEmail = `zz.e2e.aufresh${RUN_ID}@chatsphere-e2e.test`;

    const fresh = await api.post("/api/signup/check-email", { json: { email: freshEmail } });
    expect(fresh.status).toBe(200);
    expect(fresh.body).toEqual({ email: freshEmail, exists: false });

    const taken = await api.post("/api/signup/check-email", { json: { email: fixture.email } });
    expect(taken.status).toBe(200);
    expect(taken.body).toEqual({ email: fixture.email, exists: true });
  });

  it("send-otp: invalid email shape is a 400, no mail path reached", async () => {
    const res = await newApi().post("/api/signup/send-otp", { json: { email: "not-an-email" } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Enter a valid email address" });
  });

  it("send-otp: an email with an account 409s before any pending row or mail", async () => {
    const res = await newApi().post("/api/signup/send-otp", { json: { email: fixture.email } });
    // The route deliberately reveals existence here with a 409 — auth.md §2
    // allows the signup screen (alone) to do this; pin the real behavior.
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Email already exists" });

    // No pending_registration row proves the handler exited before the
    // insert+send block — i.e. no Brevo call was ever attempted.
    const rows = await db
      .select({ email: schema.pendingRegistration.email })
      .from(schema.pendingRegistration)
      .where(ops.eq(schema.pendingRegistration.email, fixture.email));
    expect(rows).toHaveLength(0);
  });

  it.skipIf(!config.testEmail)(
    "full OTP signup: send, wrong code, right code, weak password, complete",
    async () => {
      const [local, domain] = (config.testEmail as string).toLowerCase().split("@");
      const email = `${local}+e2e${RUN_ID}@${domain}`; // swept by cleanup.ts's plus-address pass
      const username = `${USERNAME_PREFIX}auotp${RUN_ID}`;
      const api = newApi();

      // The run's ONE real Brevo send.
      const send = await api.post("/api/signup/send-otp", { json: { email } });
      expect(send.status, send.text).toBe(200);
      expect(send.body).toEqual({ success: true });

      const otp = await readSignupOtp(email);
      const wrongOtp = otp === "000000" ? "000001" : "000000";

      const bad = await api.post("/api/signup/verify-otp", { json: { email, otp: wrongOtp } });
      expect(bad.status).toBe(400);
      // attemptsRemaining 2 of 3 proves the attempts counter incremented.
      expect(bad.body).toEqual({ error: "Incorrect code.", attemptsRemaining: 2 });

      const good = await api.post("/api/signup/verify-otp", { json: { email, otp } });
      expect(good.status, good.text).toBe(200);
      expect(good.body).toEqual({ success: true });
      expect(api.cookieHeader()).toContain("registration_token=");
      expect(api.hasSession()).toBe(false);

      const profile = {
        firstName: "E2e",
        lastName: "Otp",
        username,
        birthDate: "2000-01-15",
      };

      const weak = await api.post("/api/signup/complete", {
        json: { ...profile, password: "weak" },
      });
      expect(weak.status).toBe(400);
      expect(weak.body).toEqual({ error: "Please check the form and try again." });
      expect(api.hasSession()).toBe(false);

      const done = await api.post("/api/signup/complete", {
        json: { ...profile, password: PASSWORD },
      });
      expect(done.status, done.text).toBe(200);
      expect(done.body?.user?.email).toBe(email);
      // complete/route.ts's own NOTE marks these two cookie merges unverified:
      // Better Auth's session Set-Cookie must land AND the consumed
      // registration token must clear, in the one forwarded Response.
      expect(api.hasSession()).toBe(true);
      expect(api.cookieHeader()).not.toContain("registration_token=");

      const rows = await db
        .select({ username: schema.user.username, emailVerified: schema.user.emailVerified })
        .from(schema.user)
        .where(ops.eq(schema.user.email, email));
      expect(rows).toHaveLength(1);
      expect(rows[0].username).toBe(username);
      // The databaseHook stamps emailVerified — the OTP already proved the inbox.
      expect(rows[0].emailVerified).toBe(true);

      const session = await api.get("/api/auth/get-session");
      expect(session.status).toBe(200);
      expect(session.body?.user?.email).toBe(email);
    },
    60_000, // one real Brevo round-trip + first-hit route compiles
  );
});
