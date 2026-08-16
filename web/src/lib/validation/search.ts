import { z } from "zod";

// Docs/user/search.md §4: minimum 2 characters, lowercased before comparing
// (the column is already stored lowercase). Max mirrors the username ceiling —
// nothing longer can ever prefix-match a real handle.
export const searchQuerySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "Type at least 2 characters")
  .max(30);

export const SEARCH_RESULT_LIMIT = 10;

// `%` and `_` are ILIKE wildcards. Without this, q="%" matches every user and
// turns a prefix search into a full-table dump.
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
