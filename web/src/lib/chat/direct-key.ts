/**
 * The unique key for a DIRECT conversation: both member ids, sorted, joined.
 *
 * Sorted so "A messages B" and "B messages A" produce the same string and
 * collide on conversation.direct_key's unique index instead of racing into two
 * conversations — neon-http has no interactive transactions, so a
 * read-then-insert genuinely can run twice.
 *
 * ":" is unambiguous because ids are randomUUID() (hex and dashes only).
 */
export function directKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
