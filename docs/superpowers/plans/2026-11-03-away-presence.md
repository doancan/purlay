# Away Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person online but idle for five minutes, or away by their own choice, is shown away (a hollow ring) instead of active (the green dot), told to the same people and on the same frame as online.

**Architecture:** The page's existing `ACTIVE` word (D-143) is also the presence heartbeat: the server keeps each person's last word and lapses them to idle after `AWAY_AFTER_MS`, in memory on one node (`realtime/online.ts`) and in the per-person hash on several (`realtime/redis-presence.ts`). `PresenceChange` gains `away`; the presence layer's `away` is idleness only, and the announcer and the snapshot OR it with the stored choice (`users.away_chosen`). A new `PUT /api/me/away` writes the choice and re-tells the person at a new version.

**Tech Stack:** Bun, TypeScript, Elysia, Kysely/Postgres, Redis Lua scripts, React + zustand store, TypeBox contracts.

**Spec:** `docs/superpowers/specs/2026-11-03-away-presence-design.md`

## Global Constraints

- `AWAY_AFTER_MS = 300_000`, exported from `@purlay/types` beside `PRESENCE_GRACE_MS` (`packages/types/src/events.ts`).
- Offline wins: a change with `online: false` always has `away: false`; nobody offline appears in a snapshot.
- Versions only grow (D-136 §3); every away/active change takes a new version from the same source as online/offline changes (node's `next()` alone; Redis's `bump` with a directory).
- Told only to co-members, exactly as `announcePresence` does today; no new topic, no new event (`PRESENCE` only).
- The push rule (D-143, `platform/attention.ts`) is not changed: `attention.heard` is still called exactly as now.
- No frame per keystroke: the page's words stay rationed by `ACTIVE_EVERY_MS` (60 s) in `engine.announceActive`.
- Words: `presence.away` = "away" / "uzakta"; `account.setAway` = "Set yourself as away" / "Uzakta görün"; `account.setActive` = "Set yourself as active" / "Etkin görün". Use the catalogue's existing key style; the key names here are suggestions, the words are fixed.
- The ring: same size and position as the dot, a 2px border in the muted ink token, transparent inside, `data-away=""`; light and dark.
- New decision **D-257** amends D-136 §1 (next free number; check `docs/DECISIONS.md` first).
- Commits: Conventional Commits, no tool name, no ticket reference, no co-author trailer.
- Coverage floor per file: lines 0.96, functions 0.95 (`bunfig.toml`).

## Review Focus

1. A person typing continuously in Purlay must never be told away: the page's word every ≤60 s renews the 5-minute window — Task 2 test "a word every minute keeps them active for an hour".
2. A person away by choice who keeps using Purlay stays away, and a second tab or a reconnect does not turn them green — Task 4 test "the choice holds through activity and a new socket".
3. An idle person whose socket closes and reopens inside the grace stays away (a Wi-Fi blip does not turn them green); one who comes back after being offline starts active — Task 2 tests.
4. On two nodes, a person active on node A and idle on node B is active; a node dying while the person is idle there and active elsewhere leaves them active — Task 3 test.
5. A stranger or a removed member never hears an away change — Task 4 test "away is told only to co-members".

---

### Task 1: The contract and the column

**Files:**
- Modify: `packages/types/src/events.ts` (`PresenceChange`, `AWAY_AFTER_MS`)
- Modify: `packages/types/src/api.ts` (`MeResponse.awayChosen`, `SetAwayRequest`, `SetAwayResponse`)
- Modify: `packages/types/src/endpoints.ts` (endpoint `setAway`)
- Create: `packages/db/migrations/0080_away_chosen.sql`
- Modify: `packages/db/src/schema.ts` (or wherever `users` is typed; follow 0078's `google_made`)
- Modify: `docs/SCHEMA.md`
- Test: existing contract tests (`packages/types`), `apps/api/src/contract/bundle.ts` if constants are bundled (it lists `PRESENCE_GRACE_MS`; add `AWAY_AFTER_MS`)

**Interfaces:**
- Produces: `PresenceChange = { userId: Uuid; online: boolean; away: boolean; version: integer ≥ 0 }` (additionalProperties false); `AWAY_AFTER_MS = 300_000`; `MeResponse.awayChosen: boolean`; `SetAwayRequest = { away: boolean }`; `SetAwayResponse = { away: boolean }`; endpoint `{ id: 'setAway', method: 'PUT', path: '/api/me/away', auth: 'session', body: SetAwayRequest, responses: { 200: SetAwayResponse } }`; column `users.away_chosen boolean not null default false`.

- [ ] **Step 1:** Add the fields and constant; document `away` on `PresenceChange`: "online and idle for `AWAY_AFTER_MS`, or away by the person's choice (D-257); always false when offline".
- [ ] **Step 2:** Write the migration (`alter table users add column away_chosen boolean not null default false;`) with a header comment naming D-257, and the db type.
- [ ] **Step 3:** Run `bun run typecheck` — expected: errors at every `PresenceChange` literal missing `away` (api and web). Fix each mechanically with `away: false` for now (they become real in Tasks 2–5); the export/erasure column lists (`modules/export/tables.ts`, `core-export.ts`) get `away_chosen`: `'omit'` in the workspace export, `'export'` in the personal one, as `google_made` did.
- [ ] **Step 4:** `bun run typecheck && bun run lint && bun run test` — expected clean/pass. `SCHEMA.md` gets the column.
- [ ] **Step 5:** Commit `feat(contract): carry away on presence and the away choice on the person (D-257)`.

### Task 2: Idle on one node

**Files:**
- Modify: `apps/api/src/realtime/online.ts`
- Test: `apps/api/src/realtime/online.test.ts`

**Interfaces:**
- Consumes: `AWAY_AFTER_MS`, `PresenceChange` (Task 1).
- Produces on `OnlinePresence`:
  - `active(userId: string): void` — the person's page spoke. Renews their idle window; if they were told idle, tells `{ online: true, away: false }` at `next()` at once. Ignored for somebody not online on this node.
  - `retell(userId: string): Promise<void>` — tells the person's current state again at a new version (for a changed choice); nothing if they are offline.
  - `OnlineOptions.awayAfterMs?: number` (default `AWAY_AFTER_MS`).
  - Every change this module tells and every `onlineAmong` entry carries `away` = idleness only.

- [ ] **Step 1: Write the failing tests** (fake clock and timers as the file's other tests do):
  - "an arrival is active, and five quiet minutes tell away": arrived → told `{online:true, away:false}`; advance `AWAY_AFTER_MS` → told `{online:true, away:true}` at a larger version.
  - "a word every minute keeps them active for an hour": `active()` every 60 s for 60 min → exactly one change told (the arrival).
  - "the first word after a quiet spell tells active at once": idle → `active()` → told `{away:false}` without advancing time.
  - "a socket back inside the grace changes nothing, idle or not": idle, `left`, `arrived` within `PRESENCE_GRACE_MS` → nothing told, still away in `onlineAmong`.
  - "back after being offline is active": idle → left → grace passes (offline told with `away:false`) → arrived → `{away:false}`.
  - "retell says the same state at a larger version; offline says nothing".
  - "stop cancels the idle timers" (`held()` and no tells after `stop`).
- [ ] **Step 2:** Run `bun test apps/api/src/realtime/online.test.ts` — expected FAIL (`active` is not a function).
- [ ] **Step 3: Implement.** Per person on this node: last word time and whether told idle; one timer per online person, re-armed on `active` (cancel and re-arm is fine; at most one per person). Directory-less path only here; with a directory, delegate as Task 3 defines (leave a clear seam: the directory calls are added in Task 3).
- [ ] **Step 4:** Run the test file — expected PASS; `bun run typecheck`.
- [ ] **Step 5:** Commit `feat(realtime): tell a person away after five quiet minutes on one node (D-257)`.

### Task 3: Idle across nodes

**Files:**
- Modify: `apps/api/src/realtime/redis-presence.ts`
- Modify: `apps/api/src/realtime/online.ts` (directory path)
- Test: `apps/api/src/realtime/redis-presence.test.ts`, `apps/api/src/realtime/online.directory.test.ts`, `apps/api/src/realtime/shared-nodes.redis.integration.test.ts`

**Interfaces:**
- Consumes: Task 2's `active`/`retell`.
- Produces on `PresenceDirectory`:
  - `active(userId: string, awayAfterMs: number): Promise<number | null>` — records the word (hash field `a` = Redis now, idle index `purlay:online-idle` scored `a + awayAfterMs`); a version when this ended a told idle (`i` was 1 and somebody holds them), else null.
  - `retell(userId: string): Promise<PresenceChange | null>` — a bumped version and current idleness if anybody holds them, else null.
  - `sweep()` also returns idle lapses: people in the idle index whose time has come, still held, not yet told idle → set `i = 1`, bump, returned as `{online:true, away:true}`. Lapsed claims keep returning `{online:false, away:false}` as now.
  - `among()` entries carry `away` from `i`.
  - `join` of somebody nobody held sets `a = now`, `i = 0` and their idle index entry; a join while held changes neither. `leave`/sweep to offline remove the idle index entry.

- [ ] **Step 1: Write the failing tests:** script-level tests in `redis-presence.test.ts` for each rule above (the file's Redis double or a real Redis as its siblings do); in `shared-nodes.redis.integration.test.ts`: "a person idle on one node and speaking on the other is active", "a node that dies while its socket was idle leaves the person active where they speak", "an idle lapse is told once across two nodes".
- [ ] **Step 2:** Run them — expected FAIL.
- [ ] **Step 3: Implement** the scripts with the existing `NOW`/`LIVE`/`bump` helpers; `online.ts` calls `directory.active` from `active()` in the person's turn (`inTurn`), and tells what it returns; the renewal's sweep tells idle lapses. Directory unreachable: answer from this node's own record, as `arrived` does, logging at warn.
- [ ] **Step 4:** `bun test apps/api/src/realtime/` and the Redis integration files (`bun run test:integration` filtered) — expected PASS.
- [ ] **Step 5:** Commit `feat(realtime): share idleness across nodes through the presence record (D-257)`.

### Task 4: The choice, the announcer and the routes

**Files:**
- Modify: `apps/api/src/features/chat/presence/presence.ts` (announcer and snapshot OR the choice)
- Modify: `apps/api/src/realtime/router.ts` (`ACTIVE` also calls `online.active`)
- Create: `apps/api/src/ingress/http/away.ts` (route handler) and its service beside `modules/users/profile.ts` (`setAwayChoice(executor, userId, away): Promise<void>`)
- Modify: `apps/api/src/ingress/http/app.ts` (`PUT /api/me/away`), the `GET /api/me` builder (`awayChosen`), `route-ownership.test.ts`
- Test: `apps/api/src/ingress/http/away.integration.test.ts`, `presence` integration tests

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `PUT /api/me/away` `{away}` → 200 `{away}`; 400 on a non-boolean; 401 without a session. After the write, `online.retell(userId)`; the announcer reads `users.away_chosen` for the person when telling and sends `away: online && (away || chosen)`; `workspacePresence` reads the members' choices in the same query as the members and ORs them.

- [ ] **Step 1: Write the failing integration tests:**
  - "choosing away tells co-members away at a larger version, and choosing active tells active".
  - "the choice holds through activity and a new socket": choose away, send `ACTIVE`, open a second socket → no `{away:false}` heard; snapshot says away.
  - "the choice is kept while offline and tells nobody"; on the next arrival the first change heard is `away:true`.
  - "the snapshot carries away for an idle or choosing member, and lists nobody offline".
  - "away is told only to co-members": a stranger's socket and a just-removed member hear nothing.
  - "`GET /api/me` carries awayChosen"; "400 on `{away:'yes'}`".
  - "an `ACTIVE` still holds pushes exactly as before" (existing attention tests stay green unchanged).
- [ ] **Step 2:** Run — expected FAIL.
- [ ] **Step 3: Implement.** The arrival's first tell must already include the choice (the announcer reads it), so nobody sees active-then-away.
- [ ] **Step 4:** `bun run test:integration` for `apps/api/src/ingress/http/` and `features/chat/presence` — PASS; `bun run test`.
- [ ] **Step 5:** Commit `feat(presence): set yourself away, and tell away with the choice and idleness (D-257)`.

### Task 5: The client hears and draws away

**Files:**
- Modify: `apps/web/src/realtime/engine.ts` (`applyPresence` keeps `away`), the store's presence entry type
- Modify: `apps/web/src/realtime/realtime-provider.tsx` (`usePresence`)
- Modify: `apps/web/src/features/shell/presence-reader.tsx` (offline fill-ins carry `away: false`)
- Modify: `apps/web/src/ui/avatar.tsx` (`presence` prop) and every `useOnline` call site: `channel-header.tsx`, `profile-panel.tsx`, `account-menu.tsx`, `sidebar/people-list.tsx`
- Modify: `apps/web/src/features/shell/attention.tsx` (input list)
- Modify: `apps/web/src/i18n/catalogue/en.ts`, `tr.ts`
- Test: the files' existing tests beside them

**Interfaces:**
- Produces: `usePresence(userId: string, meId: string): 'active' | 'away' | undefined` replacing `useOnline` (remove `useOnline`; knip must stay clean). For yourself: your own heard entry if any; else `'active'` while connected, `undefined` otherwise. `Avatar` prop `presence?: 'active' | 'away'` replacing `online?: boolean`: the dot for active (as today), the ring (`data-away=""`) for away, nothing otherwise; the visually hidden word is `presence.online` or `presence.away`.

- [ ] **Step 1: Write the failing tests:** engine "a later away replaces an earlier active, an earlier one does not"; `usePresence` "own state is the heard one, else active while connected"; avatar "away draws the ring and says away"; people list and channel header "an away peer shows the ring"; attention "a pointer move and a wheel say active, rationed to one a minute".
- [ ] **Step 2:** Run `bun test apps/web/src/realtime apps/web/src/ui apps/web/src/features` — FAIL.
- [ ] **Step 3: Implement.** Add `'pointermove'` and `'wheel'` to `INPUT` in `attention.tsx` (the engine already rations to one word a minute); keep the visible-and-focused check.
- [ ] **Step 4:** Tests PASS; `bun run typecheck && bun run lint && bun run knip`.
- [ ] **Step 5:** Commit `feat(web): draw away as a hollow ring and count a moving pointer as being here (D-257)`.

### Task 6: Away from the account menu

**Files:**
- Modify: `apps/web/src/features/shell/account-menu.tsx`
- Modify: `apps/web/src/data/api.ts` (`setAway(away: boolean): Promise<SetAwayResponse>`)
- Modify: the `me` query's cache update after the call (as the profile dialog does)
- Test: `account-menu.test.tsx`; `apps/web/e2e/` presence spec if one draws the dot (update its expectations; add one e2e: choose away in one browser, the other sees the ring, choose active, the dot returns)

**Interfaces:**
- Consumes: `MeResponse.awayChosen`, `setAway` endpoint, `usePresence`.

- [ ] **Step 1: Write the failing tests:** "the menu offers Set yourself as away when not chosen, and Set yourself as active when chosen"; "choosing calls the route and the label flips"; "a failed call says so and keeps the label"; the own avatar shows the ring when the own entry says away.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS; the four e2e projects locally for the touched specs (`bun --no-env-file --env-file=.env.test run --filter @purlay/web e2e <specs> --project chromium-light`).
- [ ] **Step 5:** Commit `feat(web): set yourself away or active from the account menu (D-257)`.

### Task 7: Docs

**Files:**
- Modify: `docs/DECISIONS.md` (D-257, amends D-136 §1; names D-143's input list growing to pointer move and wheel, push rule unchanged), `docs/UX.md` (where presence is drawn; the account menu), `docs/API.md` (`PUT /api/me/away`, `awayChosen`, `PresenceChange.away`), `docs/ARCHITECTURE.md` §6.1 if it describes presence state, `docs/changelog/changes.md` (**Added**, `- **People** — …(D-257)`), `README.md` decision count.

- [ ] **Step 1:** Write them.
- [ ] **Step 2:** `bun run check:docs && bun run format:check && bun test scripts/changelog.test.ts` — clean.
- [ ] **Step 3:** Commit `docs: record away after five quiet minutes and away by choice (D-257)`.

### Finish

- [ ] Full suite: `bun run typecheck lint knip format:check check:docs`, `bun run test`, `bun run test:integration` (Docker on PATH). The gallery baselines change if the gallery draws an avatar ring: refresh from CI artifacts after the first push, checked by eye.
