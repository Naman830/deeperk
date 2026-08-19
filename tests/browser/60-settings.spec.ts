import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createUser, type FixtureUser } from "../src/fixtures";
import { newUserContext, snap } from "./support/helpers";

/**
 * The /settings walk: index, profile edit round-trip, privacy toggles,
 * notification switches, and the theme picker (dark default, .dark on <html>,
 * persistence through localStorage). One shared context so the appearance
 * test's localStorage survives its reload.
 */

test.describe("settings", () => {
  let user: FixtureUser;
  let ctx: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    user = await createUser("settings");
    ctx = await newUserContext(browser, user);
    page = await ctx.newPage();
  });

  test.afterAll(async () => {
    await ctx?.close();
  });

  test("/settings is the section index", async () => {
    await page.goto("/settings");
    await expect(page.getByText("Choose a section to get started.")).toBeVisible();
    await expect(page.getByRole("link", { name: /Profile/ })).toBeVisible();
    await snap(page, "settings", "index");
  });

  test("/settings/profile: edit the first name, save, reload, persisted", async () => {
    await page.goto("/settings/profile");
    await expect(page.getByLabel("First name")).toBeVisible();
    await snap(page, "settings", "profile");

    await page.getByLabel("First name").fill("Edited");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Profile saved")).toBeVisible({ timeout: 10_000 });
    await snap(page, "settings", "profile-saved");

    await page.reload();
    await expect(page.getByLabel("First name")).toHaveValue("Edited", { timeout: 10_000 });
    await snap(page, "settings", "profile-persisted");
  });

  test("/settings/privacy: toggles persist through the API", async () => {
    await page.goto("/settings/privacy");
    const toggle = page.getByLabel("Let people find me in search");
    await expect(toggle).toBeChecked(); // default EVERYONE
    await snap(page, "settings", "privacy");

    // Retry the first interaction: the SSR markup already looks complete, so a
    // click can land before hydration attaches Radix's handlers and do nothing.
    await expect(async () => {
      await toggle.click();
      await expect(toggle).not.toBeChecked({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    // The flip is optimistic and the switch is disabled while the PATCH is in
    // flight — reloading before it re-enables would cancel the request.
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
    await page.reload();
    await expect(page.getByLabel("Let people find me in search")).not.toBeChecked();
    await snap(page, "settings", "privacy-toggled");

    // Restore, so this user stays discoverable for anything later.
    const restored = page.getByLabel("Let people find me in search");
    await expect(async () => {
      await restored.click();
      await expect(restored).toBeChecked({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await expect(restored).toBeEnabled();
    await expect(restored).toBeChecked();
  });

  test("/settings/notifications: the four device switches render on", async () => {
    await page.goto("/settings/notifications");
    await expect(page.getByRole("switch")).toHaveCount(4);
    await expect(page.getByLabel("Show message popups")).toBeChecked();
    await snap(page, "settings", "notifications");

    // localStorage-backed: flips off and survives a reload in this context.
    // Same first-click hydration retry as the privacy test.
    await expect(async () => {
      await page.getByLabel("Show message popups").click();
      await expect(page.getByLabel("Show message popups")).not.toBeChecked({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await page.reload();
    await expect(page.getByLabel("Show message popups")).not.toBeChecked();
    await page.getByLabel("Show message popups").click();
    await expect(page.getByLabel("Show message popups")).toBeChecked();
  });

  test("/settings/appearance: theme toggles .dark on <html> and persists", async () => {
    await page.goto("/settings/appearance");
    const html = page.locator("html");
    await expect(html).toHaveClass(/dark/); // dark is the default
    await snap(page, "settings", "appearance-dark");

    // First-click hydration retry, as above.
    await expect(async () => {
      await page.getByRole("button", { name: /^Light/ }).click();
      await expect(html).not.toHaveClass(/dark/, { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await snap(page, "settings", "appearance-light");

    await page.reload();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await snap(page, "settings", "appearance-light-persisted");

    await page.getByRole("button", { name: /^Dark/ }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });
});
