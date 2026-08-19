import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createUser, createDirect, type FixtureUser } from "../src/fixtures";
import { newUserContext, snap } from "./support/helpers";

/**
 * The real-MediaRecorder evidence the unit-test gap analysis pointed to:
 * Chromium's fake mic (--use-fake-device-for-media-stream) feeds a tone into
 * the composer's recorder, the take uploads to real Cloudinary, and the AUDIO
 * bubble renders live for both sides with a working player.
 */

test.describe("voice note", () => {
  let a: FixtureUser;
  let b: FixtureUser;
  let conversationId: string;
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;

  test.beforeAll(async ({ browser }) => {
    a = await createUser("voicea");
    b = await createUser("voiceb");
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

  test("record ~3s on the fake mic, send, and the AUDIO bubble renders live on both sides", async () => {
    await pageA.goto(`/chats/${conversationId}`);
    await pageB.goto(`/chats/${conversationId}`);
    // Live-delivery readiness: both sockets are up once A sees B online (B
    // connected second, so A gets the presence event).
    await expect(pageA.getByText("Online", { exact: true })).toBeVisible({ timeout: 15_000 });

    await pageA.getByLabel("Record a voice message").click();
    await expect(pageA.getByText("Recording…")).toBeVisible({ timeout: 5_000 });
    await pageA.waitForTimeout(3_000);
    await snap(pageA, "voice-note", "recording-strip");

    await pageA.getByLabel("Send voice message").click();

    // Sender: optimistic AUDIO bubble, then the confirmed one — either way a
    // player with elapsed/total in m:ss (the total from the client stopwatch
    // or Cloudinary's probe). Upload goes to real Cloudinary, hence the slack.
    await expect(pageA.getByLabel("Play voice message").first()).toBeVisible({ timeout: 20_000 });
    await expect(pageA.getByText(/\d+:\d{2} \/ \d+:\d{2}/).first()).toBeVisible({ timeout: 10_000 });
    await snap(pageA, "voice-note", "sent-bubble");

    // Receiver: arrives live over the socket, no reload.
    await expect(pageB.getByLabel("Play voice message").first()).toBeVisible({ timeout: 15_000 });
    await expect(pageB.getByText(/\d+:\d{2}/).first()).toBeVisible();
    await snap(pageB, "voice-note", "receiver-bubble");
  });

  test("the received voice note actually plays", async () => {
    const play = pageB.getByLabel("Play voice message").first();
    await play.click();
    // The <audio> element fired onPlay — the flipped label is real playback,
    // not just a rendered button.
    await expect(pageB.getByLabel("Pause voice message").first()).toBeVisible({ timeout: 10_000 });
    await snap(pageB, "voice-note", "receiver-playing");
    // ~3s take: playback ends on its own and the label flips back.
    await expect(pageB.getByLabel("Play voice message").first()).toBeVisible({ timeout: 15_000 });
  });
});
