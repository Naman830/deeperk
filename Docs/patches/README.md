# Archived patches

## `message-reactions.patch`

The complete message-reactions feature (schema, server events, web UI, prefs),
built during the 2026-08-18 chat pass and removed from `main` at the owner's
request. Archived 2026-08-19, immediately before the `server/src` Express-style
restructure invalidated the live branch's patch-apply path.

- Produced with: `git diff ba9cc680 feature/message-reactions`
  (`ba9cc680` is the post-removal main commit the branch applies cleanly to —
  23 files, +649/−28).
- **It no longer applies to `main`** (paths under `server/src` moved, and
  `handlers/chat.js` was split). To restore reactions, port the hunks by hand:
  the patch is the authoritative record of what the feature contained.
- Context on what's inside and the three reintegration gotchas (QUICK_REACTIONS,
  `editedAt` is unrelated, the dropped `reaction` table) lives in `CLAUDE.md`'s
  "Chat UX expansion — Phases 2, 3 and 4" section.
