import { test, expect } from "@playwright/test";
import { createUser, PASSWORD, USERNAME_PREFIX, RUN_ID } from "../src/fixtures";
import { readSignupOtp } from "../src/otp";
import { snap } from "./support/helpers";

/**
 * The real /login and /signup forms, driven end to end. Fixture identities
 * follow the harness scheme (zz.e2e. prefix, reserved-TLD emails) — the signup
 * flow's send-otp will hand such an address to Brevo, which accepts it and
 * fails delivery asynchronously; the OTP itself is cracked from the DB the
 * same way tests/src/otp.ts always has.
 */

test.describe("login", () => {
  test("seeded user logs in via the form and lands in /chats", async ({ page }) => {
    const user = await createUser("login");

    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
    await snap(page, "auth", "login-form");

    await page.getByLabel("Email", { exact: true }).fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await snap(page, "auth", "login-filled");
    await page.getByRole("button", { name: "Log in" }).click();

    await page.waitForURL("**/chats", { timeout: 20_000 });
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await snap(page, "auth", "login-landed-chats");
  });

  test("wrong password shows the generic inline error and stays on /login", async ({ page }) => {
    const user = await createUser("badpw");

    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill("Wrong.password1");
    await page.getByRole("button", { name: "Log in" }).click();

    // Not getByRole("alert"): Next's route announcer is a second, permanent alert.
    await expect(page.getByText("Incorrect email or password.")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/login");
    await snap(page, "auth", "login-bad-password");
  });
});

test.describe("signup", () => {
  test("email step validates inline before any OTP is sent", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
    await snap(page, "auth", "signup-email-step");

    // Empty submit: passes native type=email validation (field isn't required),
    // so the app's own zod error is what renders.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Enter a valid email address")).toBeVisible();
    await snap(page, "auth", "signup-email-invalid");
  });

  test("full signup: email → OTP → profile fields → password → signed in", async ({ page }) => {
    const username = `${USERNAME_PREFIX}signup${RUN_ID}`;
    const email = `${username}@deeperk-e2e.test`;

    await page.goto("/signup");
    await page.getByLabel("Email", { exact: true }).fill(email);

    const [sendRes] = await Promise.all([
      page.waitForResponse((res) => res.url().includes("/api/signup/send-otp")),
      page.getByRole("button", { name: "Continue" }).click(),
    ]);
    // Per the harness rules: if Brevo refuses the reserved-TLD address at the
    // API (502), the OTP portion is skipped — pre-OTP validation is covered above.
    if (sendRes.status() !== 200) {
      await snap(page, "auth", "signup-send-otp-refused");
      test.skip(true, `send-otp answered ${sendRes.status()} for the .test address — OTP portion skipped`);
    }

    await expect(page.getByText(`Code sent to ${email}`)).toBeVisible();
    const otp = await readSignupOtp(email);
    await page.getByLabel(`Code sent to ${email}`).fill(otp);
    await snap(page, "auth", "signup-otp-filled");
    await page.getByRole("button", { name: "Verify" }).click();

    await expect(page.getByLabel("First name")).toBeVisible();
    await page.getByLabel("First name").fill("E2e");
    await snap(page, "auth", "signup-first-name");
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByLabel("Last name (optional)").fill("Signup");
    await snap(page, "auth", "signup-last-name");
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByLabel("Username").fill(username);
    await expect(page.getByText("✓ Available")).toBeVisible({ timeout: 10_000 });
    await snap(page, "auth", "signup-username-available");
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByLabel("Date of birth").fill("2000-01-15");
    await snap(page, "auth", "signup-birthdate");
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await snap(page, "auth", "signup-password");
    await page.getByRole("button", { name: "Create account" }).click();

    await page.waitForURL("**/chats", { timeout: 30_000 });
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await snap(page, "auth", "signup-complete-chats");
  });
});
