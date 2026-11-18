# Claiming an issue, and a board Status that shows who is working on what

Size: a small change (one script, one command, one workflow, a few lines in CONTRIBUTING §7).

## Why

Several people (and AI sessions) will work on the open backlog at the same time. Today nothing says
who has started what: no issue has an assignee, `bun run queue` shows only `Ready` and `Backlog`,
and two people can start the same issue or collide in the same files and in the same migration number.

## Goals

- Starting an issue takes one command, assigns it to the person, and refuses if it is taken.
- The board shows five stages without anyone moving cards: **Backlog**, **Ready**, **In progress**,
  **In review**, **Done**.
- The queue tells a person which ready issues are safe to start next to the work already in progress.

## Non-goals

- No hand-maintained Status (CONTRIBUTING §7: it is derived, as D-45 argues).
- No bot that opens pull requests (D-219). The workflow only assigns and writes Status.
- No change to branch names (`check:branch` keeps `feat/<slug>`), commit rules, or the CLA path.

## Anti-goals

- A claim that silently succeeds for two people at once.
- A board that drifts from reality because it needs a human to remember a step.
- A new service or dependency (CONTRIBUTING §1.11).

## What exists today (verified)

- `scripts/queue.ts` reads issues and `**Blocked by** #N` lines, and with `--apply` writes only
  `Ready` / `Backlog` to project 1 of `doancan`.
- It looks at the **current milestone only** and skips epics. 44 of the 51 open issues have no
  milestone, so the queue cannot see them at all (including #1301–#1339, #1309, #1310, #1126, #1158).
- There are no assignees on any open issue. Labels `api web database realtime contracts infra docs
  testing` already name the area.
- The board (project 1) already has all five Status options: Backlog, Ready, In progress, In review, Done
  (verified 2026-11-18 with the `project` scope). Nothing needs to be created; the script only writes
  two more of them.

## Approaches considered

1. **By hand** (Projects' built-in workflows, manual assignment). Rejected: unowned drift, and against §7.
2. **Derived status only.** Status computed from assignee and open PR. Rejected alone: nothing stops two
   people starting the same issue.
3. **Derived status plus a `claim` command.** Chosen.

## Design

### Stage derivation (in `scripts/queue.ts`, one pure function)

For each open, non-epic issue, first match wins:

| Stage | Rule |
|---|---|
| In review | an open pull request closes it (`closingIssuesReferences`) |
| In progress | it has an assignee |
| Backlog | it has an open `**Blocked by**` issue |
| Ready | otherwise |
| Done | closed (GitHub's own; the script does not write it) |

Scope changes (my call): milestone-less open issues are in scope, shown as *unscheduled*, so the queue
sees the whole backlog. The "current milestone" line stays and orders milestone work first.

The queue also prints an **In progress** block: issue, assignee, area labels, days since last update, and
flags one idle for 14 days.

### `bun run claim <number>` (new `scripts/claim.ts`)

1. Refuses a closed issue, an epic, an issue blocked by an open issue, or one that already has an assignee.
2. Assigns the current `gh` user.
3. Re-reads the assignees. If anyone else is there too (a simultaneous claim), removes itself and refuses;
   the earlier assignee keeps it. (`gh` has no compare-and-set, so this is detect and back off.)
4. Applies the conflict rules below; a refusal names the issue it conflicts with.
5. Prints the suggested branch name `feat|fix|chore/<slug>` (no issue number, no project words: §8) and
   reminds that the pull request body must say `Closes #N`, which is what moves it to *In review*.

`bun run claim <number> --release` unassigns (only your own claim).

### Conflict rules (the "do not collide" part)

- **One `database` issue in progress at a time**: migrations are append-only and numbered, so two at once
  means a renumbering. Refused.
- **`exclusive` label**: a new label for issues that move many files (#1126, #1158). It cannot start while any
  issue is in progress in its area, and while it is in progress no other issue in that area can start.
- **Same-area notice** (not a refusal): claiming an issue shows the in-progress issues sharing an area label.
- **Shared files**: the changelog and `DECISIONS.md` are conflict magnets. Rule added to §7: a D-number is
  taken when the pull request is ready to merge, by rebasing on `main` and taking the next free number; the
  changelog entry stays in the pull request as today.

### Automation (`.github/workflows/board.yml`)

On `issues` (assigned, unassigned, closed), `pull_request` (opened, reopened, closed, ready_for_review) and
a daily schedule, run `bun run queue -- --apply`. A pull request that closes an issue nobody holds assigns
its author to that issue first, so a claim made on the web or by a one-off fix is not invisible.
Actions are pinned as `supply-chain.yml` requires.

**Needs from a human:** `GITHUB_TOKEN` cannot write a user-owned Project. A fine-grained token with
Projects read/write is stored as the secret `BOARD_TOKEN`. Without it, the workflow does nothing and
`bun run queue -- --apply` is run locally.

## Verification the builder owes

- Pure tests for stage derivation and the conflict rules (`scripts/queue.test.ts`, `scripts/claim.test.ts`),
  with the `gh` calls behind one small function the tests replace.
- A real run against the real repo: claim a docs issue, see In progress on the board, open a draft PR that
  closes it, see In review, close the PR, see Ready again; and a second claim of the same issue refused.
- A simulated simultaneous claim (two assignees) backs off.
- `bun run verify`; a mutation for each refusal (`verify:enforcement` style, §6.2).

## Left to the builder

Exact option names the board needs created, the output layout of the queue, how `claim` finds the current
`gh` user, workflow triggers' fine detail.

## After this: the order of work on the open issues (separate plan)

Lanes that do not share files, started side by side; inside a lane, one at a time.

- **Docs lane** (no code): #1313, #1304, #1311.
- **Web lane**: #1309, then #1310; #1126 is `exclusive` and goes alone, before or after this lane.
- **API outbox lane** (one `database` issue at a time): #1303, #1302, #1305, then #1301 → #1308, #1338,
  #1339, #1306. #1158 is `exclusive` for the API.
- **Infra and tests lane**: #1307, #1314, then the WebKit flakes #1368 and #1371.
- **New user-facing features** (own web and API areas, no shared migration): #1379, #1380, #1381.
