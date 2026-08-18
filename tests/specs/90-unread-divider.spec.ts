import { describe, it, expect } from "vitest";
import { buildRows } from "../../web/src/app/(app)/(messaging)/chats/[conversationId]/message-list";

/**
 * Unit pin for the "N new messages" divider. Pure function, no servers — it
 * lives in this suite because the e2e harness is where regressions surface.
 *
 * The contract (message-list's own comment): the divider goes before the FIRST
 * message newer than the watermark that the viewer did not send, and the count
 * counts only those messages.
 */

const VIEWER = "viewer";
const OTHER = "other";

let n = 0;
function msg(senderId: string, createdAt: string) {
  return {
    id: `m${n++}`,
    conversationId: "c1",
    senderId,
    type: "TEXT",
    body: "hi",
    mediaUrl: null,
    mediaMime: null,
    mediaSize: null,
    mediaName: null,
    mediaWidth: null,
    mediaHeight: null,
    callId: null,
    clientMsgId: null,
    replyToId: null,
    createdAt,
    editedAt: null,
    deletedAt: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function dividerIndexAndCount(rows: ReturnType<typeof buildRows>) {
  const index = rows.findIndex((row) => row.kind === "unread");
  const row = rows[index];
  return { index, count: row && row.kind === "unread" ? row.count : null, rows };
}

describe("unread divider", () => {
  it("appears before the first unread even when that message opens a new day", async () => {
    // 48h apart so the boundary is a new day in EVERY timezone.
    const watermark = "2026-08-16T10:00:00.000Z";
    const messages = [
      msg(OTHER, "2026-08-16T09:00:00.000Z"), // read, two days ago
      msg(OTHER, "2026-08-18T09:00:00.000Z"), // first unread — opens a new day
      msg(OTHER, "2026-08-18T09:01:00.000Z"),
    ];
    const rows = buildRows(messages, watermark, VIEWER);
    const { index, count } = dividerIndexAndCount(rows);
    expect(index, "divider must exist").toBeGreaterThan(-1);
    // Immediately before the first unread message's bubble (date rows aside).
    const next = rows
      .slice(index + 1)
      .find((row) => row.kind === "message");
    expect(next && next.kind === "message" && next.message.id).toBe(messages[1].id);
    expect(count).toBe(2);
  });

  it("skips the viewer's own messages: divider lands on the first unread from someone else, count excludes own", async () => {
    const watermark = "2026-08-18T10:00:00.000Z";
    const messages = [
      msg(OTHER, "2026-08-18T09:59:00.000Z"), // read
      msg(VIEWER, "2026-08-18T10:01:00.000Z"), // own, after watermark — never "unread"
      msg(OTHER, "2026-08-18T10:02:00.000Z"), // the real first unread
      msg(OTHER, "2026-08-18T10:03:00.000Z"),
    ];
    const rows = buildRows(messages, watermark, VIEWER);
    const { index, count } = dividerIndexAndCount(rows);
    expect(index).toBeGreaterThan(-1);
    const next = rows.slice(index + 1).find((row) => row.kind === "message");
    expect(next && next.kind === "message" && next.message.id).toBe(messages[2].id);
    expect(count).toBe(2);
  });

  it("same-day happy path: divider before the first unread with the exact count", async () => {
    const watermark = "2026-08-18T10:00:00.000Z";
    const messages = [
      msg(OTHER, "2026-08-18T09:00:00.000Z"),
      msg(OTHER, "2026-08-18T10:05:00.000Z"),
      msg(OTHER, "2026-08-18T10:06:00.000Z"),
    ];
    const rows = buildRows(messages, watermark, VIEWER);
    const { index, count } = dividerIndexAndCount(rows);
    expect(index).toBeGreaterThan(-1);
    const next = rows.slice(index + 1).find((row) => row.kind === "message");
    expect(next && next.kind === "message" && next.message.id).toBe(messages[1].id);
    expect(count).toBe(2);
  });

  it("no watermark, no divider", async () => {
    const rows = buildRows([msg(OTHER, "2026-08-18T10:00:00.000Z")], null, VIEWER);
    expect(rows.every((row) => row.kind !== "unread")).toBe(true);
  });
});
