# Claim and derived board status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bun run claim <n>` assigns an issue and refuses collisions, and `bun run queue --apply` writes all five board stages derived from assignee, open pull request and blockers.

**Architecture:** The rules are pure functions in one module (`scripts/board-rules.ts`), tested without GitHub. A thin module (`scripts/board-github.ts`) owns every `gh` call. `queue.ts` and the new `claim.ts` are small callers. A workflow runs `queue --apply` on events.

**Tech Stack:** Bun, TypeScript, `bun:test`, the `gh` CLI (GraphQL for the board). No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-18-claim-and-derived-status-design.md`

## Global Constraints

- Board is user project 1 of `doancan`; Status options already exist: `Backlog`, `Ready`, `In progress`, `In review`, `Done`. The script writes only the first four; `Done` is GitHub's.
- Stage precedence, first match wins: In review (open PR closes it) > In progress (has assignee) > Backlog (open `**Blocked by** #N`) > Ready.
- Epics (body starts `> **Epic**`) and closed issues are never staged or claimable.
- No new dependency, no service (CONTRIBUTING §1.11). No bot opens pull requests (D-219).
- Branch names stay `feat|fix|chore|refactor|docs/<slug>` (`check:branch`): no issue number in a branch name. Commit messages carry no issue, task or ticket words and no AI/tool trailer (CONTRIBUTING §8; the user's rule overrides any attribution reminder).
- Actions in workflows are pinned by commit SHA with a version comment, as in `.github/workflows/supply-chain.yml`.
- `GITHUB_TOKEN` cannot write a user-owned Project; the workflow uses the secret `BOARD_TOKEN` and does nothing visible when it is absent.
- The changelog gets no entry: nothing a person using the product would notice (§6 step 6).

## Review Focus

- Two people claim the same issue within one second: exactly one keeps it; the other is refused and left unassigned.
- `claim` on an issue whose blocker closed a moment ago (stale list): re-read before refusing or accepting.
- An assigned issue that is also blocked (assigned by hand): stage is In progress, and the queue says it is blocked.
- A pull request that mentions `Closes #N` for an issue with several assignees, or for an epic: no crash, epic ignored.
- `gh` returns more than 400 issues or the board has more than 100 items: paginated, nothing silently dropped.

---

### Task 1: Pure board rules

**Files:**
- Create: `scripts/board-rules.ts`
- Test: `scripts/board-rules.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Stage = 'Backlog' | 'Ready' | 'In progress' | 'In review';
  export interface BoardIssue {
    readonly number: number; readonly title: string; readonly body: string;
    readonly state: 'OPEN' | 'CLOSED';
    readonly milestone: string | null;
    readonly labels: readonly string[];
    readonly assignees: readonly string[];
    readonly closingPullRequests: readonly number[]; // open PRs whose body closes it
    readonly updatedAt: string;                      // ISO
  }
  export const AREA_LABELS: readonly string[]; // api web database realtime contracts infra docs testing security
  export const isEpic: (i: BoardIssue) => boolean;
  export const blockersOf: (i: BoardIssue) => number[];   // moved from queue.ts, same parse
  export const stageOf: (i: BoardIssue, all: ReadonlyMap<number, BoardIssue>) => Stage;
  export type Refusal = { readonly reason: string } | null;
  export const claimRefusal: (issue: BoardIssue, all: ReadonlyMap<number, BoardIssue>, me: string) => Refusal;
  export const sameAreaInProgress: (issue: BoardIssue, all: ReadonlyMap<number, BoardIssue>) => BoardIssue[];
  export const idleDays: (i: BoardIssue, now: Date) => number;
  ```

- [ ] **Step 1: Write failing tests** in `board-rules.test.ts`, one `test` per line, using a small `issue({...})` builder:
  - `stageOf`: open PR closing it → `In review` even when assigned and blocked; assigned → `In progress` even when blocked; open blocker → `Backlog`; blocker closed → `Ready`; no blocker → `Ready`.
  - `blockersOf` parses `> **Blocked by** #4 · #12` to `[4, 12]` and returns `[]` without the line.
  - `claimRefusal` returns a reason for: closed issue, epic, assigned to someone else (reason names them), blocked (reason names the open blocker), another open issue labelled `database` already In progress when this one is `database`, an `exclusive` issue when any other issue in one of its areas is In progress, any issue sharing an area with an In progress `exclusive` issue. Returns `null` for a free issue, and for an issue already assigned to `me` (idempotent).
  - `sameAreaInProgress` lists only In progress issues sharing an area label, excluding itself.
  - `idleDays` counts whole days from `updatedAt`.
- [ ] **Step 2: Run** `bun test scripts/board-rules.test.ts` — Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the signatures above in `scripts/board-rules.ts` as pure functions (no I/O, no `Date.now()`; `now` is a parameter). `claimRefusal` checks in the listed order and returns the first reason.
- [ ] **Step 4: Run** the test — Expected: all PASS.
- [ ] **Step 5: Commit** `feat(scripts): derive board stages and claim refusals as pure rules`

### Task 2: The GitHub layer

**Files:**
- Create: `scripts/board-github.ts`

**Interfaces:**
- Consumes: `BoardIssue` (Task 1).
- Produces:
  ```ts
  export const OWNER = 'doancan'; export const REPO = 'purlay'; export const PROJECT = 1;
  export const gh: (args: readonly string[]) => string;                 // throws with stderr on failure
  export const currentUser: () => string;                               // gh api user --jq .login
  export const fetchIssues: () => BoardIssue[];                         // all open+closed, paginated, with assignees and open closing PRs
  export const fetchIssue: (n: number) => BoardIssue;                   // fresh single read (claim re-reads)
  export const assign: (n: number, user: string) => void;
  export const unassign: (n: number, user: string) => void;
  export const writeStages: (stages: ReadonlyMap<number, Stage>) => number; // returns items changed
  ```

- [ ] **Step 1:** Implement `fetchIssues` with a GraphQL query on `repository.issues` using cursor pagination (not `--limit 400`), reading `number title body state milestone{title} labels assignees updatedAt timelineItems` is not needed: open closing PRs come from `pullRequests(states: OPEN){ closingIssuesReferences{ number } }`, inverted into `closingPullRequests`.
- [ ] **Step 2:** Implement `writeStages` by moving the project-item pagination and the `updateProjectV2ItemFieldValue` mutation out of `queue.ts` unchanged, generalised from two options to the four stages; skip an item whose value already equals the wanted stage (read `fieldValueByName(name:"Status")` in the item query) so a run with nothing to change writes nothing.
- [ ] **Step 3: Verify against the real repo:** `bun -e "import {fetchIssues} from './scripts/board-github'; const a=fetchIssues(); console.log(a.length, a.filter(i=>i.state==='OPEN').length)"` — Expected: total above 590 and 51 open (±new issues); no truncation.
- [ ] **Step 4: Commit** `refactor(scripts): move the board's gh calls into one module`

### Task 3: `queue` shows every stage and the whole backlog

**Files:**
- Modify: `scripts/queue.ts` (replace its inline fetch, `blockersOf`, derivation and writer with the two modules)
- Test: `scripts/queue.test.ts` (pure part only: the text block builder)

**Interfaces:**
- Consumes: `fetchIssues`, `writeStages`, `stageOf`, `idleDays`, `isEpic`, `blockersOf`.
- Produces: `export const render: (issues: readonly BoardIssue[], now: Date) => string` in `scripts/queue-render.ts` (output text only; `queue.ts` prints it and applies).

- [ ] **Step 1: Write failing tests** for `render`: an In progress block lists `#N title — @assignee — area labels — Nd idle` and flags `idle` at 14 days or more; milestone-less open issues appear under `UNSCHEDULED` in Ready or Backlog; In review issues are listed with their PR number; epics and closed issues are absent.
- [ ] **Step 2:** Run `bun test scripts/queue.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Implement `render` and slim `queue.ts` to: fetch, print, and with `--apply` call `writeStages` with every non-epic open issue's `stageOf`.
- [ ] **Step 4:** Run the test — PASS; then `bun run queue` against the real repo — Expected: the 44 milestone-less issues now listed; an empty In progress block.
- [ ] **Step 5: Commit** `feat(scripts): show every board stage and unscheduled work in the queue`

### Task 4: `claim`

**Files:**
- Create: `scripts/claim.ts`, `scripts/claim-run.ts`
- Test: `scripts/claim.test.ts`
- Modify: `package.json` (`"claim": "bun run scripts/claim.ts"`)

**Interfaces:**
- Produces: in `claim-run.ts`
  ```ts
  export interface ClaimPorts {
    readonly me: string;
    readonly all: () => ReadonlyMap<number, BoardIssue>;
    readonly one: (n: number) => BoardIssue;      // fresh read
    readonly assign: (n: number, user: string) => void;
    readonly unassign: (n: number, user: string) => void;
  }
  export type ClaimResult = { ok: true; notices: string[] } | { ok: false; reason: string };
  export const claim: (n: number, ports: ClaimPorts) => ClaimResult;
  export const release: (n: number, ports: ClaimPorts) => ClaimResult; // only your own claim
  export const branchHint: (issue: BoardIssue) => string; // e.g. feat/<slug>, fix/<slug> from the title
  ```

- [ ] **Step 1: Write failing tests** with fake ports:
  - a free issue is assigned to `me` and the result carries same-area notices;
  - a refusal from `claimRefusal` is returned and `assign` is never called;
  - **race:** after `assign`, `one(n)` returns two assignees (`me` and another who is earlier in the list): `unassign(n, me)` is called and the result is refused naming the other; if `me` is first in the list, the claim stands;
  - re-reads `one(n)` before deciding (a stale `all()` blocker that has since closed does not refuse);
  - `release` refuses someone else's claim and unassigns your own;
  - `branchHint` uses `fix/` for `bug` label, `docs/` for `docs`-only, `chore/` for `infra`, else `feat/`; the slug is lowercase ASCII, at most 40 characters, and contains no issue number.
- [ ] **Step 2:** Run `bun test scripts/claim.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Implement `claim-run.ts` (pure over ports) and `claim.ts` (parse `<number> [--release]`, build real ports from `board-github`, print notices, the branch hint and the line `Put "Closes #N" in the pull request body.`; exit 1 with the reason on refusal).
- [ ] **Step 4:** Run the test — PASS.
- [ ] **Step 5: Real run:** `bun run claim 1313`, then `gh issue view 1313 --json assignees`, then `bun run claim 1313` again (idempotent), then `bun run queue --apply` and check the board shows In progress; then `bun run claim 1313 -- --release` and `queue --apply` shows Ready. Expected as stated; report the output.
- [ ] **Step 6: Commit** `feat(scripts): add claim to take an issue without colliding`

### Task 5: The `exclusive` label and the workflow

**Files:**
- Create: `.github/workflows/board.yml`
- Test: `scripts/board-workflow.test.ts` (reads the workflow text, as `deploy-workflow.test.ts` does)

- [ ] **Step 1: Write failing tests:** the workflow's events are exactly `issues` (assigned, unassigned, closed, reopened), `pull_request` (opened, reopened, closed, ready_for_review, edited) and `schedule`; every `uses:` is a 40-character SHA with a version comment; top-level `permissions` is `contents: read` plus `issues: write` and `pull-requests: read`; the apply step is skipped when `BOARD_TOKEN` is empty; concurrency group `board` with `cancel-in-progress: false`.
- [ ] **Step 2:** Run it — FAIL.
- [ ] **Step 3:** Write `board.yml`: checkout (no persisted credentials), setup-bun as in `supply-chain.yml`, `bun install --frozen-lockfile`, a first step that, for a `pull_request` event, assigns the PR author to each issue the PR closes that has no assignee (`gh issue edit --add-assignee`), then `bun run queue -- --apply` with `GH_TOKEN: ${{ secrets.BOARD_TOKEN }}`. Daily cron at a quiet hour.
- [ ] **Step 4:** Run the test — PASS; run `bun run lint` for the workflow's YAML if the repo lints it.
- [ ] **Step 5: With the user's go-ahead (it writes to GitHub):** `gh label create exclusive --description "Moves many files: no other work in its area while it runs"` and add it to #1126 and #1158.
- [ ] **Step 6: Commit** `ci(board): keep the board's stages current from events`

### Task 6: Documents, guards and the pull request

**Files:**
- Modify: `CONTRIBUTING.md` (§7 step 2: claim, stages, conflict rules, D-number at rebase), `docs/DECISIONS.md` (new decision, next free number at rebase time, currently D-313; rejected: by hand, derived-only), `scripts/mutations.ts` (one entry per refusal in `claimRefusal` and for the race back-off), `README`'s decision count if it states one.

- [ ] **Step 1:** Write the §7 text and the decision, citing D-45 and D-219.
- [ ] **Step 2:** Add the mutation entries; for each run `bun run mutate <id>` — Expected: caught (a test fails) for every entry.
- [ ] **Step 3:** Run `bun run verify` with the database (own `purlay_<topic>` database if other worktrees run) — Expected: all green; paste the real output.
- [ ] **Step 4:** Open the PR from the topic branch `feat/claim-and-board-stages`; body: what changes, verification output, the six failure-mode bullets only if `apps/` or `packages/` were touched (they are not). The linked issue needs a `testing` or `infra` label so `check:pr` accepts the tooling paths; create the issue first with those labels.
- [ ] **Step 5:** Tell the user the one human step: add the `BOARD_TOKEN` secret (fine-grained token, Projects read and write for `doancan`), and that until then `bun run queue -- --apply` runs locally.
