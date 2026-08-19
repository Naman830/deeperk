import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createUser, type FixtureUser } from "../src/fixtures";
import { newUserContext, snap } from "./support/helpers";

/**
 * People search in the chats column and /u/[username] privacy gating, with
 * the privacy owners flipping their own settings over their REST sessions.
 */

test.describe("search and profile privacy", () => {
  let viewer: FixtureUser;
  let target: FixtureUser;
  let hidden: FixtureUser;
  let ctx: BrowserContext;
  let page: Page;

  const BIO = "Browser-suite bio: gated by profileDetails.";

  test.beforeAll(async ({ browser }) => {
    viewer = await createUser("viewer");
    target = await createUser("target");
    hidden = await createUser("ghost");

    const bio = await target.api.patch("/api/me", { json: { bio: BIO } });
    if (bio.status !== 200) throw new Error(`bio setup failed (${bio.status}): ${bio.text.slice(0, 200)}`);
    const privacy = await hidden.api.patch("/api/me/privacy", { json: { discoverable: "NOBODY" } });
    if (privacy.status !== 200) throw new Error(`privacy setup failed (${privacy.status}): ${privacy.text.slice(0, 200)}`);

    ctx = await newUserContext(browser, viewer);
    page = await ctx.newPage();
  });

  test.afterAll(async () => {
    await ctx?.close();
  });

  test("search finds a discoverable user in the chats column", async ({}) => {
    await page.goto("/chats");
    await page.getByLabel("Search people by username").fill(target.username);
    await expect(page.getByText(`@${target.username}`)).toBeVisible({ timeout: 10_000 });
    await snap(page, "profile-search", "search-hit");
  });

  test("a discoverable=NOBODY user does not appear in search", async () => {
    await page.getByLabel("Search people by username").fill(hidden.username);
    // §5 wording: identical whether nothing matched or every match was hidden.
    await expect(page.getByText("No one found")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(`@${hidden.username}`)).toHaveCount(0);
    await snap(page, "profile-search", "search-hidden-user");
  });

  test("/u/<username> shows the bio while profileDetails allows it", async () => {
    await page.goto(`/u/${target.username}`);
    await expect(page.getByText(BIO)).toBeVisible();
    await snap(page, "profile-search", "profile-bio-visible");
  });

  test("after the owner sets profileDetails=NOBODY the bio is gone", async () => {
    const res = await target.api.patch("/api/me/privacy", { json: { profileDetails: "NOBODY" } });
    expect(res.status).toBe(200);

    await page.reload();
    await expect(page.getByText("This user keeps their profile details private.")).toBeVisible();
    await expect(page.getByText(BIO)).toHaveCount(0);
    await snap(page, "profile-search", "profile-bio-gated");
  });
});
