/**
 * The setup in the browser, before any of its screens (D-179 §4): the one-time code, the claim that
 * binds the setup to one browser, the steps it has passed, and the door that closes for good. Over one
 * row, `setup_state` (migration 0050); whether setup is *finished* is `server_settings`'s
 * `setup_completed_at`, read here and written only by the finish rule.
 *
 * - **Open or closed** (`setupStatus`). Closed rests on two facts, either enough: the setup is finished
 *   (`setup_completed_at`), or a user exists other than the administrator an unfinished setup made
 *   (`admin_user_id`, which finishing clears — so after it every user closes the door, the
 *   administrator too, and losing the settings row reopens nothing). Only a server with no user at all
 *   is open, which is a fresh install. A server that had people before this version is closed from its
 *   first start (design §7.14). Closed, every function here refuses, and a start clears whatever an
 *   unfinished setup left and writes no code — with one allowance (Ruling R42): while the finish is not
 *   written, users who arrived during the setup close it to everybody but the browser holding a valid
 *   claim, which may still pass its steps and finish; a start then keeps that claim.
 * - **The code** (`issueSetupCode`): a new one at every start while open — twenty symbols of 32 that
 *   cannot be taken for one another (no 0, O, 1 or I), 100 bits, in groups of four — written once, to
 *   the log, at `warn`, and kept only as its digest. It is the one secret logged on purpose: its field,
 *   `setupCode`, is not on the logger's never-logged list, and nothing else here logs a value. It opens
 *   for an hour (Ruling R39); after that the right code is answered, and counted, as a wrong one. A
 *   later start's code replaces any earlier one.
 * - **Guessing** (`claimSetup`). A wrong code is counted for the server, not for an address — the code
 *   is the server's secret — in SQL, under the row's lock; the fifth locks every claim for fifteen
 *   minutes, the right code included. The lock belongs to the code (Ruling R40): a new code at a start
 *   begins with no count and no lock, since five guesses at 100 bits are worth nothing however often a
 *   start can be forced. That undoes only a slow stranger: one who keeps guessing locks the new code
 *   five requests after each start, and neither a restart nor the statement `CONFIG.md` gives to clear
 *   a lock lets the operator in — the per-client limit on the `/setup` routes, a requirement of the
 *   endpoint, is what answers it. A claim made starts the count again too.
 * - **The claim**: the row is locked while a code is weighed, so of two browsers sending the right code
 *   at once exactly one wins and the code is spent by it. The winner is handed a token once — a cookie
 *   for the route to set — and only its digest is kept.
 * - **Lost and abandoned**: a browser with its token resumes at the step it reached
 *   (`requireSetupClaim`); a claim idle for a day no longer opens. A browser without it needs a code, and
 *   the code is spent — the operator restarts the server and reads the new one from the log. That code
 *   takes the unfinished setup over, at the step it reached, **only once the claim has been idle fifteen
 *   minutes** (Ruling R39): a claim whose browser was seen — by the guard or a step recorded — within
 *   them is refused to every code, so a code read later from a kept log cannot take a setup from an
 *   operator at work. The browser that held a claim taken over is refused from its next request.
 *
 * The finish rule — a way for other people to sign in connected after a try that worked (§4.5) — is
 * not here: it needs what serves now, and is `finishSetup` in `wizard.ts`, which checks it and then
 * calls `completeSetup` in the same transaction. Which channels were tried is remembered here, with the
 * step (`recordChannelTried`).
 */
import { sql, type Executor, type Transaction } from '@purlay/db';
import { SETUP_STEPS, type SetupStep } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { DAY_MS } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { noteSession, type Logger } from '../../platform/logging';
import { sessionFromHeaders, twoFactorRequired } from '../auth/sessions';
import type { Auth } from '../auth/better-auth';
import { atomicallyOn } from '../../platform/transactions';
import { digestsEqual, randomSymbols, randomToken, tokenDigest } from '../../platform/tokens';

/** Wrong codes the server takes before it locks every claim. */
export const SETUP_ATTEMPTS = 5;
/** How long the lock lasts. */
export const SETUP_LOCK_MS = 15 * 60 * 1000;
/** How long a claim stays open with nothing heard from its browser: what its cookie lasts, too. */
export const SETUP_CLAIM_IDLE_MS = DAY_MS;
/** How long a code opens after the start that issued it (Ruling R39). */
export const SETUP_CODE_TTL_MS = 60 * 60 * 1000;
/** How long a claim must have gone unseen before a code may take it over (Ruling R39). */
export const SETUP_TAKEOVER_IDLE_MS = 15 * 60 * 1000;
/** The browser's id, as the column bounds it. */
const BROWSER_ID_MAX = 128;

/**
 * A control character (Unicode `Cc`) — NUL among them, which Postgres refuses in text, a raw 500 — or
 * a format character (`Cf`): U+202E, a bidi override, would let an id shown to an operator read as
 * another.
 */
const CONTROL = /[\p{Cc}\p{Cf}]/u;

/** 32 symbols, so one random byte picks one evenly; no 0, O, 1 or I. 5 bits each. */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_GROUPS = 5;
const CODE_GROUP_LENGTH = 4;

/** The log line the code is in: a constant, so an operator can search for it (`CONFIG.md`). */
export const SETUP_CODE_LINE = 'SETUP CODE: open /setup on this server in a browser and enter it';

/** What a start of a closed server says instead: no code, and why. */
export const SETUP_CLOSED_LINE =
  'setup is closed: this server is set up, so no setup code is issued';

/** Why a setup function refused. One refusal for every failure of a claim's token, so none is told apart. */
export type SetupRefusal =
  | { readonly reason: 'closed' }
  | { readonly reason: 'wrong-code' }
  | { readonly reason: 'locked'; readonly until: Date }
  | { readonly reason: 'claimed' }
  | { readonly reason: 'not-claimed' }
  | { readonly reason: 'out-of-order' }
  | { readonly reason: 'invalid-browser' };

const SENTENCES: Record<SetupRefusal['reason'], string> = {
  closed: 'This server is set up already.',
  'wrong-code': 'That is not the setup code.',
  locked: 'Too many wrong setup codes. Wait, then try again.',
  claimed: 'Setup is in progress in another browser.',
  'not-claimed': 'This browser is not setting this server up.',
  'out-of-order': 'That step comes later.',
  'invalid-browser': 'This browser could not be told apart from another.',
};

export class SetupRefused extends Error {
  readonly refusal: SetupRefusal;

  constructor(refusal: SetupRefusal) {
    super(SENTENCES[refusal.reason]);
    this.name = 'SetupRefused';
    this.refusal = refusal;
  }
}

/** A browser's claim, as the claim hands it over: the token goes to the browser and is not kept. */
export interface SetupClaim {
  readonly claimToken: string;
  /** The steps passed already: none but the claim, unless this claim took over an unfinished setup. */
  readonly steps: readonly SetupStep[];
}

/**
 * A claim as the setup's steps weigh it: by its digest, again, under the row's lock (`heldBy`). What a
 * step is handed needs no more than this — the step itself refuses a digest that does not hold the
 * claim, however the caller came by it.
 */
export interface SetupClaimDigest {
  readonly claimDigest: string;
}

/** Not exported: naming this key is minting a session, and only `requireSetupClaim` does. */
const claimed: unique symbol = Symbol('SetupSession');

/**
 * What the guard proves of a request: the claim it was made under, by its digest — branded, so a value
 * of the type comes only from `requireSetupClaim` (Ruling R48). What takes this rather than a
 * `SetupClaimDigest` is what checks nothing of its own against the database — the probes of GitHub
 * and of a relay (`probes.ts`) — so a route cannot reach them without passing the guard. An assertion
 * into the type is refused by lint, as a context's is.
 */
export interface SetupSession extends SetupClaimDigest {
  readonly [claimed]: true;
}

/** Not exported: minted only by `requireServerAdmin`, with Administration → Server (D-179 §4.8). */
const serverAdmin: unique symbol = Symbol('ServerAdminSession');

/**
 * A signed-in server administrator, as the guard of Administration → Server proves one — the other
 * authority the probes take, for trying new settings after setup (D-179 §4.8). `requireServerAdmin`
 * below is the only thing that makes one; an assertion into the type is refused by lint.
 */
export interface ServerAdminSession {
  readonly userId: string;
  readonly [serverAdmin]: true;
}

/**
 * The guard of Administration → Server (D-179 §4.8): the request's own live session, whose account is
 * the server's administrator (`users.is_server_admin`) and is not erased. Nothing else decides it — not
 * a field of the request, not a workspace role: an owner of a workspace is not the server's administrator.
 *
 * **Every way of not being one is the one answer, `404 ROUTE_NOT_FOUND`** — signed out, a stale cookie,
 * a member, a workspace's owner, an erased account: the route is shaped as absent to everybody it is
 * not for, so nobody learns from it that the server has an administration (the setup's own convention,
 * `SETUP_UNAVAILABLE`). Read from the database each time, so an administrator demoted or erased loses
 * the page with their next request, whatever session they hold.
 */
export const requireServerAdmin = async (
  auth: Auth,
  executor: Executor,
  headers: Headers,
): Promise<ServerAdminSession> => {
  const owner = await sessionFromHeaders(auth, headers);
  const admin =
    owner === undefined
      ? undefined
      : await executor
          .selectFrom('users')
          .select('id')
          .where('id', '=', owner.userId)
          .where('is_server_admin', '=', true)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
  if (owner === undefined || admin === undefined) {
    throw new AppError({ code: 'ROUTE_NOT_FOUND', message: 'No such route.' });
  }
  // The administrator too is held back until their second step is on, where the server requires it (D-239):
  // asked only of the administrator, so everybody else is still the one answer above.
  if (await auth.owesTwoFactor(owner.userId)) throw twoFactorRequired();
  noteSession(owner.sessionId);
  const minted: ServerAdminSession = { userId: admin.id, [serverAdmin]: true };
  return minted;
};

/** A digest no token has, compared with when there is none to compare with: the same work either way. */
const NO_DIGEST = '0'.repeat(64);

/** The code as typed — any case, with or without its dashes and spaces — in the form its digest is of. */
const canonicalCode = (presented: string): string => presented.replace(/[\s-]/g, '').toUpperCase();

const newCode = (): string => {
  const symbols = randomSymbols(CODE_ALPHABET, CODE_GROUPS * CODE_GROUP_LENGTH);
  return Array.from({ length: CODE_GROUPS }, (_, group) =>
    symbols.slice(group * CODE_GROUP_LENGTH, (group + 1) * CODE_GROUP_LENGTH),
  ).join('-');
};

/** Steps up to and including the one reached, in order. */
const stepsUpTo = (reached: string | null): SetupStep[] => {
  const index = SETUP_STEPS.findIndex((step) => step === reached);
  return SETUP_STEPS.slice(0, index + 1);
};

/**
 * The two facts that close the server to setup: finished, and a user the setup did not make. Read on the
 * executor given — inside a transaction that holds the row, they are read under that lock.
 */
const closure = async (executor: Executor): Promise<{ finished: boolean; peopled: boolean }> => {
  const row = await executor
    .selectNoFrom((eb) => [
      eb
        .exists(
          eb.selectFrom('server_settings').select('id').where('setup_completed_at', 'is not', null),
        )
        .as('finished'),
      eb
        .exists(
          eb
            .selectFrom('users')
            .select('users.id')
            .where(
              'users.id',
              'is distinct from',
              eb
                .selectFrom('setup_state')
                .select('admin_user_id')
                .where('setup_state.id', '=', true),
            ),
        )
        .as('peopled'),
    ])
    .executeTakeFirstOrThrow();
  return { finished: row.finished === true, peopled: row.peopled === true };
};

/** Closed to anybody but the claim's holder: either fact. */
const isClosed = async (executor: Executor): Promise<boolean> => {
  const { finished, peopled } = await closure(executor);
  return finished || peopled;
};

/**
 * Closed to the claim's holder: only the finish (Ruling R42). Users who arrived during the setup — an
 * invitee who accepted before **Finish** was pressed — close it to everybody else, but the browser
 * that holds the claim may still reach the finish, so `setup_completed_at` is written and the door then
 * rests on both facts. Called only once the claim's token or session has matched.
 */
const isClosedToTheHolder = async (executor: Executor): Promise<boolean> =>
  (await closure(executor)).finished;

/** A row with no code, no count and no lock. */
const NO_CODE = {
  code_digest: null,
  code_issued_at: null,
  failed_attempts: 0,
  locked_until: null,
} as const;

/** A row with no claim. */
const NO_CLAIM = {
  claim_digest: null,
  claimed_at: null,
  claimed_by: null,
  claim_seen_at: null,
} as const;

/** What the functions here read of the row. */
interface SetupRow {
  readonly code_digest: string | null;
  readonly code_issued_at: Date | null;
  readonly failed_attempts: number;
  readonly locked_until: Date | null;
  readonly claim_digest: string | null;
  readonly claim_seen_at: Date | null;
  readonly step_reached: string | null;
  readonly admin_user_id: string | null;
  /** When a GitHub app the probe accepted was saved by the setup (migration 0052). */
  readonly github_tried_at: Date | null;
  /** When a relay that took the test letter was saved by the setup. */
  readonly email_tried_at: Date | null;
}

/** The row, locked for the rest of the transaction; made first if a database has lost it. */
const lockedState = async (transaction: Transaction): Promise<SetupRow> => {
  await transaction
    .insertInto('setup_state')
    .values({ id: true })
    .onConflict((conflict) => conflict.column('id').doNothing())
    .execute();
  return await transaction
    .selectFrom('setup_state')
    .select([
      'code_digest',
      'code_issued_at',
      'failed_attempts',
      'locked_until',
      'claim_digest',
      'claim_seen_at',
      'step_reached',
      'admin_user_id',
      'github_tried_at',
      'email_tried_at',
    ])
    .where('id', '=', true)
    .forUpdate()
    .executeTakeFirstOrThrow();
};

export const setupStatus = async (executor: Executor): Promise<'open' | 'closed'> =>
  (await isClosed(executor)) ? 'closed' : 'open';

/**
 * At a start: a new code, its digest kept and the code itself written to the log once. Does nothing on
 * a closed server. Never returns the code: the log is the only place it is shown.
 */
export const issueSetupCode = async (
  executor: Executor,
  log: Logger,
  clock: Clock,
): Promise<void> => {
  const issued = await atomicallyOn(executor)(async (transaction) => {
    const state = await lockedState(transaction);
    const { finished, peopled } = await closure(transaction);
    if (!finished && peopled) {
      // Closed by users alone: no code and no count, but a claim's holder may still finish (R42).
      await transaction.updateTable('setup_state').set(NO_CODE).where('id', '=', true).execute();
      return undefined;
    }
    if (finished) {
      // Nothing an unfinished setup left may open anything now: no code, no claim, no count.
      await transaction
        .updateTable('setup_state')
        .set({
          ...NO_CODE,
          ...NO_CLAIM,
          step_reached: sql<string | null>`case when step_reached = 'finish' then step_reached end`,
          step_reached_at: sql<Date | null>`case when step_reached = 'finish' then step_reached_at end`,
        })
        .where('id', '=', true)
        .execute();
      return undefined;
    }
    const code = newCode();
    await transaction
      .updateTable('setup_state')
      // The count and the lock were the last code's (Ruling R40).
      .set({
        code_digest: await tokenDigest(canonicalCode(code)),
        code_issued_at: clock.now(),
        failed_attempts: 0,
        locked_until: null,
      })
      .where('id', '=', true)
      .execute();
    return { code, inProgress: state.claim_digest !== null };
  });
  if (issued === undefined) {
    log.info(SETUP_CLOSED_LINE);
    return;
  }
  // After the commit: a code the log shows is one the row holds.
  log.warn(SETUP_CODE_LINE, {
    setupCode: issued.code,
    // A code read now takes over a setup somebody started and did not finish.
    takesOverAnUnfinishedSetup: issued.inProgress,
  });
};

/**
 * A browser presenting the code. Exactly one claim wins the code; a wrong one is counted, and the count
 * is committed before the refusal is thrown.
 */
export const claimSetup = async (
  executor: Executor,
  code: string,
  browserId: string,
  clock: Clock,
): Promise<SetupClaim> => {
  // Before anything is weighed: a bad id is the route's mistake, not a guess, and spends nothing.
  if (browserId.length === 0 || browserId.length > BROWSER_ID_MAX || CONTROL.test(browserId)) {
    throw new SetupRefused({ reason: 'invalid-browser' });
  }
  const presented = await tokenDigest(canonicalCode(code));
  const claimToken = randomToken();
  const claimDigest = await tokenDigest(claimToken);
  const outcome = await atomicallyOn(executor)(
    async (transaction): Promise<SetupClaim | SetupRefusal> => {
      const state = await lockedState(transaction);
      if (await isClosed(transaction)) return { reason: 'closed' };
      const now = clock.now();
      if (state.locked_until !== null && state.locked_until > now) {
        return { reason: 'locked', until: state.locked_until };
      }
      if (state.claim_digest !== null) {
        // Spent by a claim that holds it: not a guess, and no code can be right.
        if (state.code_digest === null) return { reason: 'claimed' };
        // A claim at work is nobody else's, whatever code is sent (Ruling R39).
        const seen = state.claim_seen_at ?? now;
        if (now.getTime() - seen.getTime() < SETUP_TAKEOVER_IDLE_MS) return { reason: 'claimed' };
      }
      const matches = digestsEqual(presented, state.code_digest ?? NO_DIGEST);
      // A start "in the future" is a clock moved back: the code is not trusted to be within its hour.
      const age =
        state.code_issued_at === null ? -1 : now.getTime() - state.code_issued_at.getTime();
      const live = age >= 0 && age < SETUP_CODE_TTL_MS;
      if (!matches || !live) {
        // Counted by the database, under the row's lock: no two guesses read the same count.
        const counted = await transaction
          .updateTable('setup_state')
          .set((eb) => ({ failed_attempts: eb('failed_attempts', '+', 1) }))
          .where('id', '=', true)
          .returning('failed_attempts')
          .executeTakeFirstOrThrow();
        if (counted.failed_attempts < SETUP_ATTEMPTS) return { reason: 'wrong-code' };
        const until = new Date(now.getTime() + SETUP_LOCK_MS);
        await transaction
          .updateTable('setup_state')
          .set({ failed_attempts: 0, locked_until: until })
          .where('id', '=', true)
          .execute();
        return { reason: 'locked', until };
      }
      const steps = stepsUpTo(state.step_reached);
      const reached = steps.length === 0 ? 'claim' : undefined;
      await transaction
        .updateTable('setup_state')
        .set({
          ...NO_CODE,
          claim_digest: claimDigest,
          claimed_at: now,
          claimed_by: browserId,
          claim_seen_at: now,
          ...(reached === undefined ? {} : { step_reached: reached, step_reached_at: now }),
        })
        .where('id', '=', true)
        .execute();
      return { claimToken, steps: reached === undefined ? steps : [reached] };
    },
  );
  if ('reason' in outcome) throw new SetupRefused(outcome);
  return outcome;
};

/**
 * The guard of every later step: the claim this browser's token is, still open. Every way of failing
 * — closed, unclaimed, no token, a wrong one, one taken over, one idle a day — is the one refusal.
 */
export const requireSetupClaim = async (
  executor: Executor,
  claimToken: string | undefined,
  clock: Clock,
): Promise<SetupSession> => {
  const presented = await tokenDigest(claimToken ?? '');
  const now = clock.now();
  const session = await atomicallyOn(executor)(async (transaction) => {
    const state = await lockedState(transaction);
    const matches = digestsEqual(presented, state.claim_digest ?? NO_DIGEST);
    const fresh =
      state.claim_seen_at !== null &&
      now.getTime() - state.claim_seen_at.getTime() < SETUP_CLAIM_IDLE_MS;
    if (claimToken === undefined || !matches || !fresh || state.claim_digest === null) {
      return undefined;
    }
    if (await isClosedToTheHolder(transaction)) return undefined;
    await transaction
      .updateTable('setup_state')
      .set({ claim_seen_at: now })
      .where('id', '=', true)
      .execute();
    const minted: SetupSession = { claimDigest: state.claim_digest, [claimed]: true };
    return minted;
  });
  if (session === undefined) throw new SetupRefused({ reason: 'not-claimed' });
  return session;
};

/**
 * The row, locked, if the session's claim still holds it on an open server; the refusal if not. The
 * guard of every step's write, here and beside it (`admin.ts`): the lock is held until the caller's
 * transaction ends.
 */
export const heldBy = async (
  transaction: Transaction,
  session: SetupClaimDigest,
): Promise<SetupRow | { readonly reason: 'closed' | 'not-claimed' }> => {
  const state = await lockedState(transaction);
  const holds =
    state.claim_digest !== null && digestsEqual(session.claimDigest, state.claim_digest);
  if (!holds)
    return (await isClosed(transaction)) ? { reason: 'closed' } : { reason: 'not-claimed' };
  if (await isClosedToTheHolder(transaction)) return { reason: 'closed' };
  return state;
};

/**
 * A step passed, and the claim's browser seen. In order — the next one, or one passed already, which
 * changes nothing — so the steps passed are always every step up to the last. `finish` is refused here
 * as well as by the type: a request schema built from `SETUP_STEPS` would let it through, and it is
 * `completeSetup`'s alone.
 */
export const recordStep = async (
  executor: Executor,
  session: SetupClaimDigest,
  step: Exclude<SetupStep, 'finish'>,
  clock: Clock,
): Promise<void> => {
  const refusal = await atomicallyOn(executor)(
    async (transaction): Promise<SetupRefusal | undefined> => {
      const state = await heldBy(transaction, session);
      if ('reason' in state) return state;
      const reached = SETUP_STEPS.indexOf(step);
      const furthest = SETUP_STEPS.findIndex((known) => known === state.step_reached);
      if ((step as SetupStep) === 'finish') return { reason: 'out-of-order' };
      if (reached > furthest + 1) return { reason: 'out-of-order' };
      const now = clock.now();
      await transaction
        .updateTable('setup_state')
        .set({
          claim_seen_at: now,
          ...(reached <= furthest ? {} : { step_reached: step, step_reached_at: now }),
        })
        .where('id', '=', true)
        .execute();
      return undefined;
    },
  );
  if (refusal !== undefined) throw new SetupRefused(refusal);
};

/** Whether `step` may be taken after `passed`: one passed already, or the next. */
export const reachable = (passed: readonly SetupStep[], step: SetupStep): boolean =>
  SETUP_STEPS.indexOf(step) <= passed.length;

/**
 * A way for other people to sign in, saved after a try that worked (D-179 §4.5, Ruling R47): its step
 * recorded and the try remembered, in one transaction, so the finish rule can tell an app GitHub
 * accepted from one that is merely in the settings. Refused as `recordStep` refuses.
 */
export const recordChannelTried = async (
  executor: Executor,
  session: SetupClaimDigest,
  channel: 'github' | 'email',
  clock: Clock,
): Promise<void> => {
  await atomicallyOn(executor)(async (transaction) => {
    await recordStep(transaction, session, channel, clock);
    const now = clock.now();
    await transaction
      .updateTable('setup_state')
      .set(channel === 'github' ? { github_tried_at: now } : { email_tried_at: now })
      .where('id', '=', true)
      .execute();
  });
};

/** The steps the session's setup has passed, in order: where its wizard resumes. Marks the claim seen. */
export const stepsOf = async (
  executor: Executor,
  session: SetupClaimDigest,
  clock: Clock,
): Promise<readonly SetupStep[]> => {
  const outcome = await atomicallyOn(executor)(async (transaction) => {
    const state = await heldBy(transaction, session);
    if ('reason' in state) return state;
    // Asking is being seen (Ruling R39): a browser reading its steps is not idle.
    await transaction
      .updateTable('setup_state')
      .set({ claim_seen_at: clock.now() })
      .where('id', '=', true)
      .execute();
    return stepsUpTo(state.step_reached);
  });
  if ('reason' in outcome) throw new SetupRefused(outcome);
  return outcome;
};

/**
 * Finishes the setup, once the finish rule (`finishSetup`, `wizard.ts`) has found a way for other people
 * to sign in connected after a try that worked. In one transaction: the finish set in `server_settings`, the administrator
 * forgotten — so from now on every user closes the door, the administrator too — `finish` recorded, and
 * the claim and any code spent. A failure anywhere leaves the setup unfinished and the claim held.
 */
export const completeSetup = async (
  executor: Executor,
  session: SetupClaimDigest,
  clock: Clock,
): Promise<void> => {
  const finished = await atomicallyOn(executor)(
    async (transaction): Promise<SetupRefusal | 'finished'> => {
      const state = await heldBy(transaction, session);
      if ('reason' in state) return state;
      if (state.step_reached !== SETUP_STEPS[SETUP_STEPS.indexOf('finish') - 1]) {
        return { reason: 'out-of-order' };
      }
      const now = clock.now();
      await transaction
        .insertInto('server_settings')
        .values({ id: true, setup_completed_at: now, updated_at: now })
        .onConflict((conflict) =>
          conflict.column('id').doUpdateSet({ setup_completed_at: now, updated_at: now }),
        )
        .execute();
      await transaction
        .updateTable('setup_state')
        .set({
          ...NO_CODE,
          ...NO_CLAIM,
          admin_user_id: null,
          step_reached: 'finish',
          step_reached_at: now,
        })
        .where('id', '=', true)
        .execute();
      return 'finished';
    },
  );
  if (finished !== 'finished') throw new SetupRefused(finished);
};
