import { test, expect } from "@playwright/test";
import { createUser, createDirect, type FixtureUser } from "../src/fixtures";
import { adoptSession } from "./support/session";
import { snap } from "./support/helpers";

/**
 * @mobile — runs in the Pixel 7 project (the desktop project also matches the
 * file, hence the isMobile guard). The rail becomes a bottom tab bar, the
 * shell shows one column at a time, and the composer still sends.
 */

test.describe("mobile shell @mobile", () => {
  test.skip(({ isMobile }) => !isMobile, "Pixel 7 project only");

  let me: FixtureUser;
  let partner: FixtureUser;

  test.beforeAll(async () => {
    me = await createUser("mobilea");
    partner = await createUser("mobileb");
    await createDirect(me, partner);
  });

  test("bottom tab bar, open a chat, composer sends @mobile", async ({ page, context }) => {
    await adoptSession(context, me);

    await page.goto("/chats");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav).toBeVisible();
    // The rail is a bottom tab bar here: pinned to the viewport's bottom edge,
    // with the desktop wordmark hidden.
    const viewport = page.viewportSize();
    const box = await nav.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeGreaterThan(viewport!.height - 2);
    expect(box!.y).toBeGreaterThan(viewport!.height - 100);
    await expect(nav.getByText("Deeperk")).toBeHidden();
    await expect(nav.getByRole("link", { name: /^Chats/ })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Calls" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Settings" })).toBeVisible();
    await snap(page, "mobile", "chats-tab-bar");

    // Open the DM from the list — on mobile the thread replaces the list.
    await page.getByRole("link", { name: /E2e mobileb/ }).click();
    await page.waitForURL("**/chats/**");
    const composer = page.getByLabel("Write a message");
    await expect(composer).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to chats" })).toBeVisible();

    const body = `Mobile hello ${Date.now()}`;
    await composer.fill(body);
    await page.getByLabel("Send", { exact: true }).click();
    await expect(page.getByText(body)).toBeVisible({ timeout: 10_000 });
    await snap(page, "mobile", "thread-sent");
  });
});
