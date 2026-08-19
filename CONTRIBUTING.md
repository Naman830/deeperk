# Contributing to ChatSphere

Thanks for taking a look. This guide is short and specific to this repo — it covers the
things that will silently break if you don't know them, not generic Git advice.

---

## Ground rules

### Install and run from the repo root — always

This is an npm **workspaces** monorepo (`web`, `server`, `tests`) with a shared `db/`
package at the root. `server/src/config/db.js` requires `../../db`, and `web/` imports the
same module, so a `cd server && npm install` misses half its dependencies and a
`web/`-only production build misses half its code.

```bash
git clone https://github.com/Naman830/webRTC.git
cd webRTC
npm install          # from the ROOT
npm run dev          # boots web (:3000) and server (:4000) together
```

See the [README](README.md#getting-started) for the full env setup.

### Four house rules that fail quietly

These are not style preferences. Each one has already cost this codebase real debugging
time, and none of them is caught by `tsc` or ESLint.

1. **Import Drizzle operators from `@/lib/db/drizzle-ops`, never from `drizzle-orm`
   directly, in any `.ts` file under `web/`.** `db/schema/*.js` is CommonJS and resolves
   drizzle-orm's `require` types (`.d.cts`); `web/`'s TypeScript resolves the `import`
   types (`.d.ts`). TypeScript treats the two `SQL`/`Column` classes as unrelated — the
   classic dual-package hazard. The CommonJS shim at `web/src/lib/db/drizzle-ops.js` is
   what holds it closed. If you need an operator it doesn't export yet, **add it to the
   shim** rather than importing around it.
2. **`db/` stays CommonJS** (`require` / `module.exports`), matching `db/index.js`. It is
   loaded by both an ESM-flavoured Next app and a plain Node process.
3. **A table that isn't re-exported from its domain barrel is silently never created.**
   Every new table under `db/schema/<domain>/` must be added to that folder's `index.js`,
   which the root `db/schema/index.js` spreads. Drizzle Kit only sees what the barrel
   exports — no error, just a missing table.
4. **Don't add `"use client"` unless the component genuinely needs it.** Losing the
   directive fails loudly at build time; *adding* it needlessly passes `tsc`, passes
   ESLint, renders fine — and quietly ships a component to the browser while pushing every
   consumer across a boundary that didn't exist.

### Never hard-delete a `user` row

Message, call and conversation history all assume `user` rows persist forever, possibly
anonymized. Account deletion is a 30-day soft schedule (`user.deletionScheduledAt`) that a
nightly job finishes by anonymizing the row **in place**. Every foreign key from a
historical table to `user` is `ON DELETE RESTRICT` as a guardrail.

---

## Working on the schema

The schema lives in `db/schema/<domain>/`, one file per table, and is applied with
`drizzle-kit push` — there are no SQL migration files.

```bash
npx drizzle-kit generate    # against a SCRATCH config — review the SQL it would emit
npx drizzle-kit push        # applies to the REAL database
```

**`npx drizzle-kit push` writes to the live Neon database.** Review with `generate`
against a scratch config first, and don't run `push` as a side effect of a code change —
it's an outward action. The push spinner can sit for 60–90s with no output before
finishing; that's normal on this driver, not a hang.

Enum columns are a deliberate either/or: native Postgres `pgEnum` for stable sets, plain
`text` + Zod validation for sets the docs say will grow (extending a live enum needs
`ALTER TYPE`, which is awkward under a push-only workflow). If you add a status- or
type-like column, ask which bucket it belongs in rather than defaulting.

Reference: [`Docs/database/schema.md`](Docs/database/schema.md) (table-by-table) and
[`Docs/database/db-connection.md`](Docs/database/db-connection.md) (how it's wired).

---

## The socket contract is mirrored by hand

There is no codegen between `server/` and `web/`. A change on one side must land on the
other in the same commit:

| Change | Also update |
| --- | --- |
| `serializeMessage()` in `server/src/controllers/shared.js` | `toChatMessage` and `ChatMessage` in `web/src/lib/chat/types.ts` |
| A new client→server event | its handler under `server/src/controllers/`, plus the emit site in `web/src/lib/` |
| A new server→client event | the listener list in `web/src/app/(app)/realtime-provider.tsx` or `web/src/lib/call/session.ts` |
| The message payload shape | `MESSAGE_FIELDS` in `tests/specs/00-contracts.spec.ts` **and** `tests/specs/65-socket-call.spec.ts` |

`tests/specs/00-contracts.spec.ts` pins the REST and socket message shapes against each
other, so a dropped field fails the suite rather than shipping.

Registration order inside `server/src/socket/connection.js` is load-bearing — see
["Ordering rules"](server/README.md#%EF%B8%8F-ordering-rules-that-are-load-bearing) in the
server README before touching it.

---

## Testing before you open a PR

Both suites run against a **live dev server and the real Neon database** — there is no
mocking layer and no CI yet, so running them locally is the gate.

```bash
# terminal 1
npm run dev

# terminal 2
npm test               # Vitest: REST, sockets, the internal bridge, page renders
npm run test:browser   # Playwright: real browser flows, fake mic, real WebRTC
```

Read [`tests/README.md`](tests/README.md) **first**. The parts that matter most:

- Fixture users must carry the `zz.e2e.` username prefix — `tests/src/cleanup.ts`
  discovers and removes fixtures by that prefix alone. A fixture that loses its prefix
  leaks into the real database permanently.
- The suite is serial on purpose, and specs are number-prefixed because they run in
  alphabetical order.
- Two specs send real email and only run when `TEST_EMAIL` is set on the command line.

---

## Docs come first

Behaviour is specified in [`Docs/`](Docs) before it is built — `user/auth.md`,
`user/profile.md`, `user/search.md`, `chat/chat.md`, `call/call.md`. If you're adding a
feature, write or extend its spec first; if a spec and the code disagree about
*behaviour*, the spec wins and the difference is a bug worth flagging.

Where a spec names an *implementation* detail that changed during the build, the code
wins — see the note in the [README's documentation index](README.md#documentation).

---

## Commits and branches

- Commit messages follow `type(scope): summary` — e.g. `fix(voice): enforce the duration
  bound server-side`, `test(browser): add the Playwright harness`.
- Branch from `main`; feature branches are named `feature/<thing>`, cleanups
  `chore/<thing>`.
- Keep commits bisectable: one logical change each, with the test that pins it.
- Tick completed work off [`Docs/roadmap.md`](Docs/roadmap.md).

## Questions

Open an issue at [github.com/Naman830/webRTC/issues](https://github.com/Naman830/webRTC/issues).
