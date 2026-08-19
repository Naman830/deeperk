import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createUser, createDirect, type FixtureUser } from "../src/fixtures";
import { newUserContext, snap } from "./support/helpers";

/**
 * Two real browser contexts on one DM: live delivery, the typing indicator,
 * and the unread badge + toast on /chats. Presence ("Online" in the thread
 * header) doubles as the both-sockets-connected readiness signal.
 */

test.describe("chat realtime", () => {
  let a: FixtureUser;
  let b: FixtureUser;
  let conversationId: string;
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;

  test.beforeAll(async ({ browser }) => {
    a = await createUser("chata");
    b = await createUser("chatb");
    conversationId = await createDirect(a, b);
    ctxA = await newUserContext(browser, a);
    ctxB = await newUserContext(browser, b);
    pageA = await ctxA.newPage();
    pageB = await ctxB.newPage();
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test("a text message lands live on the other side, no reload", async () => {
    await pageA.goto(`/chats/${conversationId}`);
    await pageB.goto(`/chats/${conversationId}`);
    // A sees B come online via the live presence event (B connected after A
    // was already in the room) — this also proves both sockets are up.
    await expect(pageA.getByText("Online", { exact: true })).toBeVisible({ timeout: 15_000 });
    // B's SSR ran before A's connect landed, and there is no presence snapshot
    // on connect (server only emits presence:online/offline events), so B can
    // read a stale "Offline" forever — reload once both sides are connected.
    await pageB.reload();
    await expect(pageB.getByText("Online", { exact: true })).toBeVisible({ timeout: 15_000 });

    const body = `Hello from A ${Date.now()}`;
    await pageA.getByLabel("Write a message").fill(body);
    await pageA.getByLabel("Send", { exact: true }).click();

    await expect(pageA.getByText(body)).toBeVisible();
    await snap(pageA, "chat", "thread-sender");
    await expect(pageB.getByText(body)).toBeVisible({ timeout: 10_000 });
    await snap(pageB, "chat", "thread-receiver");
  });

  test("typing shows a live indicator on the other side", async () => {
    await pageB.getByLabel("Write a message").pressSequentially("typing test message", { delay: 40 });
    await expect(pageA.getByText(/is typing/).first()).toBeVisible({ timeout: 5_000 });
    await snap(pageA, "chat", "typing-indicator");
    await pageB.getByLabel("Write a message").fill("");
  });

  test("a new message badges the conversation on /chats and raises a toast", async () => {
    // Client-side navigation via the rail, NOT goto(): a full page load drops
    // B's socket, and a message sent during the reconnect window is missed
    // entirely (the badge would then come from the REST refetch — no toast).
    await pageB.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Chats/ }).click();
    await pageB.waitForURL("**/chats");
    await expect(pageB.getByText("Select a conversation")).toBeVisible();

    const body = `Unread ping ${Date.now()}`;
    await pageA.getByLabel("Write a message").fill(body);
    await pageA.getByLabel("Send", { exact: true }).click();

    // The conversation row's unread Badge (the rail badge shares the same
    // aria-label shape, hence .first() rather than a strict single match).
    await expect(pageB.getByLabel(/^\d+ unread$/).first()).toBeVisible({ timeout: 10_000 });
    // B is on /chats with the thread closed, so the toast must fire.
    await expect(pageB.locator(".Toastify").getByText(body)).toBeVisible({ timeout: 10_000 });
    // Let the toast's enter animation finish so the screenshot shows it.
    await pageB.waitForTimeout(600);
    await snap(pageB, "chat", "unread-badge-and-toast");
  });
});
