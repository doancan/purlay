# D-354. Code nothing runs is removed, with the Accounts card and the map half of the push bound — amends D-233, D-298

**Decided (the owner, 2026-11-27).** The owner asked for dead code to be removed. `bun run knip` read four exports nothing
imports (`OUTBOX_HOLDS`, `OutboxHold`, `FrameProjectors`, `PresenceAnnouncerDependencies`), and a scan of every export
against the files that ship (the compiler's reading of each name, then each hit by hand) found code that only its own tests
reached. Two of those pieces are named by a decision, so the decisions change with them.

**What changed.**

1. **Settings → Server's Accounts card is removed** (`settings/pages/server-accounts.tsx`). Nothing has mounted it since the
   standalone console took the page over (D-278): a test drew it in a composition of its own. Suspending and lifting an
   account is the console's Users page (`administration/users.tsx`), with the same words, the same refusals and the same
   routes. The card's client call (`ServerClient.accounts`), its tests and the seven catalogue words only it said go with
   it. The route `GET /api/server/accounts` stays: it is the API's (`API.md`), and the suspension D-233 decided is
   unchanged.
2. **The map half of the push queue's bound is removed** (`dropOldest`, D-298 §3). Its one caller, the notices held in
   memory, moved to PostgreSQL with D-307 (`adcbb765`); the line's half (`dropOldestOf`, `admit`) is what the sender's queue
   uses, and stays with its tests and mutations.
3. **The rest of what nothing reached:** the web cache's `channelStarred` (a star is painted through the placement ledger,
   `data/channel-placement.ts`; the test of #1198 now drives that path, `starred.test.tsx`), `DIRECTORY_EXTERNAL_ID_MAX` and
   `EndpointId` in `@purlay/types`, an orphaned comment in `star-toggle.tsx`, and 44 more catalogue words no code names
   (each checked against every literal and every template a key is built from); the four exports knip read are no longer
   exported.
4. **A helper written three times or more is one:** a row's instant on the wire is `isoInstant` (`platform/clock.ts`)
   instead of nine copies in chat; a channel named in a list of items from many places is `useChannelLabel` and
   `ChannelName` (`chat/channel/channel-header.tsx`) instead of five; the browser suite's `rowWith` and `wallClock` are
   `e2e/support.ts`'s instead of seven and two copies.

Nothing a person or a client sees changes.

**Rejected.**

- *Removing the route `GET /api/server/accounts` with the card*: it is a documented endpoint of the contract, and a client
  outside this repository may read it; removing it is a change to the API, not a removal of dead code.
- *Moving the test conveniences that live beside production code* (`chatWorkspaceHooks`, `chatUserErased`,
  `readWorkspaceAccessDecision`, `directMessageKey`) into `testing/`: they are used by many tests and cost nothing shipped;
  moving them is churn.
- *Keeping `dropOldest` for a future map*: it is twelve lines in the history, and code a decision names but nothing runs is
  a claim the record has to keep qualifying (as D-352 said of the domain bus).

**Cost of reversing.** Low: everything removed is in the history before this commit, and no table, route or wire type
changed.
