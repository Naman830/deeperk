import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createUser, createDirect, type FixtureUser } from "../src/fixtures";
import { newUserContext, snap } from "./support/helpers";

/**
 * WebRTC audio calls over the real signaling server, mic from Chromium's fake
 * device. server/.env sets CALL_RING_TIMEOUT_MS=5000 in this environment, so
 * the accept must land fast (4s expect budget on the modal) and the missed
 * flow only needs ~6s of patience.
 *
 * Two conversations on purpose: the invite handler has a per-conversation
 * 20s/2 redial cooldown, so the answered call and the missed call each get
 * their own DM rather than racing that window.
 */

test.describe("calls", () => {
  let a: FixtureUser;
  let b: FixtureUser;
  let c: FixtureUser;
  let convAB: string;
  let convAC: string;
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let ctxC: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let pageC: Page;

  test.beforeAll(async ({ browser }) => {
    a = await createUser("calla");
    b = await createUser("callb");
    c = await createUser("callc");
    convAB = await createDirect(a, b);
    convAC = await createDirect(a, c);
    ctxA = await newUserContext(browser, a);
    ctxB = await newUserContext(browser, b);
    ctxC = await newUserContext(browser, c);
    pageA = await ctxA.newPage();
    pageB = await ctxB.newPage();
    pageC = await ctxC.newPage();
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
    await ctxC?.close();
  });

  test("audio call: ring, accept, running timer both sides, hang up, history row", async () => {
    await pageA.goto(`/chats/${convAB}`);
    await pageB.goto("/chats");
    // B's socket must be live to receive the ring; A seeing B "Online" in the
    // thread header proves it (B connected after A joined the room).
    await expect(pageA.getByText("Online", { exact: true })).toBeVisible({ timeout: 15_000 });

    await pageA.getByLabel("Start audio call").click();
    await expect(pageA.getByText(/Ringing…|Joining…/)).toBeVisible({ timeout: 5_000 });
    await snap(pageA, "call", "outgoing-ringing");

    const modal = pageB.getByRole("alertdialog");
    await expect(modal).toBeVisible({ timeout: 4_000 });
    await expect(modal).toContainText("Incoming audio call");
    await snap(pageB, "call", "incoming-modal");
    await pageB.getByRole("button", { name: "Accept" }).click();

    // In-call UI on both sides, with a timer that actually runs.
    await expect(pageA.getByLabel("Hang up")).toBeVisible({ timeout: 10_000 });
    await expect(pageB.getByLabel("Hang up")).toBeVisible({ timeout: 10_000 });
    const timer = pageA.getByText(/^\d+:\d{2}$/).first();
    await expect(timer).toBeVisible({ timeout: 10_000 });
    const before = await timer.textContent();
    await pageA.waitForTimeout(2_500);
    const after = await pageA.getByText(/^\d+:\d{2}$/).first().textContent();
    expect(after).not.toBe(before);
    await expect(pageB.getByText(/^\d+:\d{2}$/).first()).toBeVisible({ timeout: 10_000 });
    await snap(pageA, "call", "in-call-caller");
    await snap(pageB, "call", "in-call-callee");

    await pageA.getByLabel("Hang up").click();
    await expect(pageA.getByLabel("Hang up")).toBeHidden({ timeout: 10_000 });
    await expect(pageB.getByLabel("Hang up")).toBeHidden({ timeout: 10_000 });

    await pageA.goto("/calls");
    await expect(pageA.getByText(/Call ended/).first()).toBeVisible({ timeout: 10_000 });
    await snap(pageA, "call", "history-ended");
  });

  test("unanswered ring expires to a missed call in history", async () => {
    await pageA.goto(`/chats/${convAC}`);
    await pageC.goto("/chats");
    await expect(pageA.getByText("Online", { exact: true })).toBeVisible({ timeout: 15_000 });

    await pageA.getByLabel("Start audio call").click();
    const modal = pageC.getByRole("alertdialog");
    await expect(modal).toBeVisible({ timeout: 4_000 });
    await snap(pageC, "call", "incoming-ignored");

    // CALL_RING_TIMEOUT_MS=5000: the ring expires on its own for both sides.
    await expect(modal).toBeHidden({ timeout: 10_000 });
    await expect(pageA.getByLabel("Hang up")).toBeHidden({ timeout: 10_000 });

    await pageC.goto("/calls");
    await expect(pageC.getByText("Missed audio call").first()).toBeVisible({ timeout: 10_000 });
    await snap(pageC, "call", "history-missed-callee");

    await pageA.goto("/calls");
    await expect(pageA.getByText("No answer").first()).toBeVisible({ timeout: 10_000 });
    await snap(pageA, "call", "history-caller-no-answer");
  });
});
