/**
 * The setup in the browser, before any of its screens (D-179 §4): the one-time code a start writes to
 * the log, the throttle on guessing it, the claim that binds the setup to one browser, the steps it
 * resumes from, and the door that closes once the server has a user or the setup is finished.
 *
 * On a database of each test's own (`cloneIntegrationDatabase`): a refusal's count must be committed to
 * be counted, and the races need two connections that see each other, as two browsers' requests do.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cloneIntegrationDatabase, closeIntegrationDatabase, sql, type Executor } from '@purlay/db';
import { SETUP_STEPS, type SetupStep } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { DAY_MS } from '../../platform/clock';
import { createLogger, type Logger } from '../../platform/logging';
import { tokenDigest } from '../../platform/tokens';
import { aUserRow } from '../../testing/users';
import {
  claimSetup,
  issueSetupCode,
  recordStep,
  requireSetupClaim,
  SETUP_ATTEMPTS,
  SETUP_CLOSED_LINE,
  SETUP_CODE_LINE,
  SETUP_CODE_TTL_MS,
  SETUP_LOCK_MS,
  SETUP_TAKEOVER_IDLE_MS,
  completeSetup,
  SetupRefused,
  setupStatus,
  stepsOf,
  type SetupRefusal,
} from './setup';

const clones: (() => Promise<void>)[] = [];
// Every test's database, dropped after its connections have closed: up to 38 of them, which fitted the
// five seconds a hook is given only on an idle machine (#797, D-228).
afterAll(async () => {
  await Promise.all(
    clones.map(async (drop) => {
      await drop();
    }),
  );
  await closeIntegrationDatabase();
}, 60_000);

/** A database of the test's own, cloned from the migrated template: no user, no settings, no code. */
const aServer = async (): Promise<Executor> => {
  const clone = await cloneIntegrationDatabase();
  clones.push(clone.drop);
  return clone.db;
};

/** A clock the test moves. */
interface MovableClock extends Clock {
  readonly advance: (ms: number) => void;
}
const movable = (start: string): MovableClock => {
  let now = new Date(start).getTime();
  return {
    now: () => new Date(now),
    advance: (ms): void => {
      now += ms;
    },
  };
};

/** A log whose every line is kept, as the operator's terminal would show it. */
const recording = (): { log: Logger; lines: string[] } => {
  const lines: string[] = [];
  return {
    log: createLogger({
      level: 'debug',
      write: (line) => {
        lines.push(line);
      },
    }),
    lines,
  };
};

/** The start of a process: a code issued, read back from the log the way an operator reads it. */
const aStart = async (db: Executor, clock: Clock): Promise<{ code: string; lines: string[] }> => {
  const { log, lines } = recording();
  await issueSetupCode(db, log, clock);
  const said = lines
    .map((line) => JSON.parse(line) as { msg?: string; setupCode?: unknown })
    .filter((line) => line.msg === SETUP_CODE_LINE);
  const [line] = said;
  if (said.length !== 1 || typeof line?.setupCode !== 'string') {
    throw new Error(`expected one setup code line, found ${String(said.length)}`);
  }
  return { code: line.setupCode, lines };
};

/** What a refused promise was refused with: the refusal's reason, or the error if it was not one. */
const refusalOf = async (promise: Promise<unknown>): Promise<SetupRefusal> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SetupRefused) return error.refusal;
    throw error;
  }
  throw new Error('expected a refusal');
};

/** The row as stored: what a dump of the database holds. */
const stateOf = async (db: Executor): Promise<SetupState> =>
  await db.selectFrom('setup_state').selectAll().where('id', '=', true).executeTakeFirstOrThrow();

interface SetupState {
  readonly admin_user_id: string | null;
  readonly code_digest: string | null;
  readonly code_issued_at: Date | null;
  readonly failed_attempts: number;
  readonly locked_until: Date | null;
  readonly claim_digest: string | null;
  readonly claimed_by: string | null;
  readonly step_reached: string | null;
  readonly step_reached_at: Date | null;
}

const START = '2026-10-22T09:00:00.000Z';
const WRONG = 'AAAA-AAAA-AAAA-AAAA-AAAA';

describe('integration: the setup code (D-179 §4.1)', () => {
  test('a start on a server with no user writes one code to the log, in one line, and keeps only its digest', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code, lines } = await aStart(db, clock);

    // Twenty symbols in five groups, from 32 that cannot be mistaken for one another: 100 bits.
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){4}$/);
    expect(lines.filter((line) => line.includes(code))).toHaveLength(1);

    const row = await stateOf(db);
    expect(row.code_digest).toBe(await tokenDigest(code.replaceAll('-', '')));
    expect(row.code_issued_at).toEqual(clock.now());
    // Nowhere in the database: not the code as shown, not its symbols without the dashes.
    const dump = await sql<{ text: string }>`
      select string_agg(row_to_json(t)::text, ' ') as text from (
        select * from setup_state
      ) t`.execute(db);
    const everything = dump.rows.map((r) => r.text).join(' ');
    expect(everything).not.toContain(code);
    expect(everything).not.toContain(code.replaceAll('-', ''));
    expect(everything).not.toContain(code.replaceAll('-', '').toLowerCase());
  });

  test('the code is in no other line: a claim, its refusals and the steps after it write none', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { log, lines } = recording();
    await issueSetupCode(db, log, clock);
    const line = lines.find((l) => l.includes(SETUP_CODE_LINE));
    const code = (JSON.parse(line ?? '{}') as { setupCode: string }).setupCode;
    await refusalOf(claimSetup(db, WRONG, 'browser-a', clock));
    const { claimToken } = await claimSetup(db, code, 'browser-a', clock);
    await recordStep(db, await requireSetupClaim(db, claimToken, clock), 'admin', clock);
    // A second start: a new code, in a line of its own, and the first one appears nowhere new.
    await issueSetupCode(db, log, clock);
    expect(lines.filter((l) => l.includes(code))).toHaveLength(1);
    expect(lines.filter((l) => l.includes(SETUP_CODE_LINE))).toHaveLength(2);
  });

  test('is a new code at every start: one a later start replaced no longer opens setup', async () => {
    const db = await aServer();
    const clock = movable(START);
    const first = await aStart(db, clock);
    const second = await aStart(db, clock);
    expect(second.code).not.toBe(first.code);
    expect(await refusalOf(claimSetup(db, first.code, 'browser-a', clock))).toEqual({
      reason: 'wrong-code',
    });
    expect((await claimSetup(db, second.code, 'browser-a', clock)).claimToken).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  test('is taken as typed: lower case, spaces or no dashes', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    const typed = ` ${code.toLowerCase().replaceAll('-', ' ')} `;
    expect((await claimSetup(db, typed, 'browser-a', clock)).claimToken).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('integration: guessing the code (D-179 §4.1)', () => {
  test('refuses a wrong code and counts the attempt', async () => {
    const db = await aServer();
    const clock = movable(START);
    await aStart(db, clock);
    expect(await refusalOf(claimSetup(db, WRONG, 'browser-a', clock))).toEqual({
      reason: 'wrong-code',
    });
    expect((await stateOf(db)).failed_attempts).toBe(1);
  });

  test(`the ${String(SETUP_ATTEMPTS)}th wrong code locks setup for fifteen minutes, the right code included`, async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    for (let attempt = 1; attempt < SETUP_ATTEMPTS; attempt += 1) {
      expect(await refusalOf(claimSetup(db, WRONG, 'browser-a', clock))).toEqual({
        reason: 'wrong-code',
      });
    }
    const until = new Date(clock.now().getTime() + SETUP_LOCK_MS);
    expect(SETUP_LOCK_MS).toBe(15 * 60 * 1000);
    expect(await refusalOf(claimSetup(db, WRONG, 'browser-a', clock))).toEqual({
      reason: 'locked',
      until,
    });
    expect((await stateOf(db)).locked_until).toEqual(until);

    clock.advance(SETUP_LOCK_MS - 1);
    expect(await refusalOf(claimSetup(db, code, 'browser-a', clock))).toEqual({
      reason: 'locked',
      until,
    });
    // A refusal while locked is not another attempt: the lock does not grow.
    expect((await stateOf(db)).locked_until).toEqual(until);

    clock.advance(1);
    await claimSetup(db, code, 'browser-a', clock);
    // A claim made starts the count again.
    expect((await stateOf(db)).failed_attempts).toBe(0);
  });

  test('a lock that runs out starts the count again: one wrong code after it is one, and only the fifth locks', async () => {
    const db = await aServer();
    const clock = movable(START);
    await aStart(db, clock);
    for (let attempt = 0; attempt < SETUP_ATTEMPTS; attempt += 1) {
      await refusalOf(claimSetup(db, WRONG, 'browser-a', clock));
    }
    clock.advance(SETUP_LOCK_MS);
    for (let attempt = 1; attempt < SETUP_ATTEMPTS; attempt += 1) {
      expect(await refusalOf(claimSetup(db, WRONG, 'browser-a', clock))).toEqual({
        reason: 'wrong-code',
      });
      expect((await stateOf(db)).failed_attempts).toBe(attempt);
    }
    expect((await refusalOf(claimSetup(db, WRONG, 'browser-a', clock))).reason).toBe('locked');
  });

  test('the lock belongs to the code: a restart issues a new one, the count is 0 and the new code claims at once (R40)', async () => {
    const db = await aServer();
    const clock = movable(START);
    await aStart(db, clock);
    for (let attempt = 0; attempt < SETUP_ATTEMPTS + 2; attempt += 1) {
      await refusalOf(claimSetup(db, WRONG, 'browser-a', clock));
    }
    expect((await stateOf(db)).locked_until).not.toBeNull();
    await refusalOf(claimSetup(db, WRONG, 'browser-a', clock));
    const { code } = await aStart(db, clock);
    const row = await stateOf(db);
    expect(row.failed_attempts).toBe(0);
    expect(row.locked_until).toBeNull();
    expect((await claimSetup(db, code, 'browser-a', clock)).steps).toEqual(['claim']);
  });

  test('the statement CONFIG.md gives clears a lock without a restart', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    for (let attempt = 0; attempt < SETUP_ATTEMPTS; attempt += 1) {
      await refusalOf(claimSetup(db, WRONG, 'browser-a', clock));
    }
    expect((await refusalOf(claimSetup(db, code, 'browser-a', clock))).reason).toBe('locked');
    const document = readFileSync(join(import.meta.dir, '../../../../../docs/CONFIG.md'), 'utf8');
    const statement = /`(UPDATE setup_state SET [^`]+;)`/.exec(document)?.[1];
    if (statement === undefined) throw new Error('CONFIG.md no longer gives the statement');
    await sql.raw(statement).execute(db);
    expect((await claimSetup(db, code, 'browser-a', clock)).steps).toEqual(['claim']);
  });

  test('fifty wrong codes sent at once are each counted: four refused as wrong, the rest locked', async () => {
    const db = await aServer();
    const clock = movable(START);
    await aStart(db, clock);
    const refusals = await Promise.all(
      Array.from(
        { length: 50 },
        async () => await refusalOf(claimSetup(db, WRONG, 'browser-a', clock)),
      ),
    );
    expect(refusals.filter((r) => r.reason === 'wrong-code')).toHaveLength(SETUP_ATTEMPTS - 1);
    expect(refusals.filter((r) => r.reason === 'locked')).toHaveLength(50 - (SETUP_ATTEMPTS - 1));
    expect((await stateOf(db)).locked_until).not.toBeNull();
  });
});

describe('integration: the code’s hour (R39)', () => {
  test('a code opens for an hour from its start, and no longer: the right code after it is answered and counted as a wrong one', async () => {
    const db = await aServer();
    const clock = movable(START);
    expect(SETUP_CODE_TTL_MS).toBe(60 * 60 * 1000);
    const { code } = await aStart(db, clock);
    clock.advance(SETUP_CODE_TTL_MS);
    expect(await refusalOf(claimSetup(db, code, 'browser-a', clock))).toEqual({
      reason: 'wrong-code',
    });
    expect((await stateOf(db)).failed_attempts).toBe(1);

    // A clock moved back behind the start does not keep the code alive: a code from the future is dead.
    const back = await aServer();
    const backed = await aStart(back, clock);
    clock.advance(-60_000);
    expect(await refusalOf(claimSetup(back, backed.code, 'browser-a', clock))).toEqual({
      reason: 'wrong-code',
    });
    clock.advance(60_000);

    const fresh = await aServer();
    const started = await aStart(fresh, clock);
    clock.advance(SETUP_CODE_TTL_MS - 1);
    expect((await claimSetup(fresh, started.code, 'browser-a', clock)).steps).toEqual(['claim']);
  });
});

describe('integration: taking over a claim (R39)', () => {
  test('a claim seen within fifteen minutes cannot be taken, even by a fresh right code, which is not spent by the refusal', async () => {
    const db = await aServer();
    const clock = movable(START);
    const first = await aStart(db, clock);
    const a = await claimSetup(db, first.code, 'browser-a', clock);
    const { code } = await aStart(db, clock);
    clock.advance(SETUP_TAKEOVER_IDLE_MS - 1_000);
    expect(await refusalOf(claimSetup(db, code, 'browser-b', clock))).toEqual({
      reason: 'claimed',
    });
    // The holder is seen again: the fifteen minutes start over from now.
    await requireSetupClaim(db, a.claimToken, clock);
    clock.advance(SETUP_TAKEOVER_IDLE_MS - 1_000);
    expect(await refusalOf(claimSetup(db, code, 'browser-b', clock))).toEqual({
      reason: 'claimed',
    });
    expect((await stateOf(db)).failed_attempts).toBe(0);
    // Asking for the steps is being seen.
    await stepsOf(db, { claimDigest: await tokenDigest(a.claimToken) }, clock);
    clock.advance(SETUP_TAKEOVER_IDLE_MS - 1_000);
    expect((await refusalOf(claimSetup(db, code, 'browser-b', clock))).reason).toBe('claimed');
    // A step recorded is being seen too.
    await recordStep(db, await requireSetupClaim(db, a.claimToken, clock), 'admin', clock);
    clock.advance(SETUP_TAKEOVER_IDLE_MS - 1_000);
    expect((await refusalOf(claimSetup(db, code, 'browser-b', clock))).reason).toBe('claimed');
    // Idle a moment past the fifteen minutes: the same, unspent code takes it.
    clock.advance(2_000);
    expect((await claimSetup(db, code, 'browser-b', clock)).steps).toEqual(['claim', 'admin']);
    expect(await refusalOf(requireSetupClaim(db, a.claimToken, clock))).toEqual({
      reason: 'not-claimed',
    });
  });

  test('a spent code is answered as claimed, not counted as a guess, however idle the claim', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    await claimSetup(db, code, 'browser-a', clock);
    clock.advance(SETUP_TAKEOVER_IDLE_MS + 60_000);
    expect(await refusalOf(claimSetup(db, code, 'browser-b', clock))).toEqual({
      reason: 'claimed',
    });
    expect((await stateOf(db)).failed_attempts).toBe(0);
  });
});

describe('integration: the browser’s id', () => {
  test('an empty, overlong or control-character one is refused before the code is weighed, and the code is not spent', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    for (const browserId of [
      '',
      'b'.repeat(129),
      'browser\u0000a',
      'browser\na',
      'browser\u007fa',
      'browser‮a',
      'browser​a',
    ]) {
      expect(await refusalOf(claimSetup(db, code, browserId, clock))).toEqual({
        reason: 'invalid-browser',
      });
    }
    expect((await stateOf(db)).failed_attempts).toBe(0);
    expect((await claimSetup(db, code, 'b'.repeat(128), clock)).steps).toEqual(['claim']);
  });
});

describe('integration: the claim (D-179 §4.2)', () => {
  test('a correct code claims: the token is handed back once, only its digest is kept, and the code is spent', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    await refusalOf(claimSetup(db, WRONG, 'browser-a', clock));
    const claim = await claimSetup(db, code, 'browser-a', clock);
    expect(claim.claimToken).toMatch(/^[0-9a-f]{64}$/);
    // The guess before it is forgotten: the count starts again once a claim is made.
    expect((await stateOf(db)).failed_attempts).toBe(0);
    expect(claim.steps).toEqual(['claim']);
    const row = await stateOf(db);
    expect(row.claim_digest).toBe(await tokenDigest(claim.claimToken));
    expect(JSON.stringify(row)).not.toContain(claim.claimToken);
    expect(row.claimed_by).toBe('browser-a');
    expect(row.code_digest).toBeNull();
    expect(row.step_reached).toBe('claim');
  });

  test('a second correct claim, from another browser, is refused: the code was spent by the first', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    await claimSetup(db, code, 'browser-a', clock);
    expect(await refusalOf(claimSetup(db, code, 'browser-b', clock))).toEqual({
      reason: 'claimed',
    });
    expect((await stateOf(db)).claimed_by).toBe('browser-a');
  });

  test('lets exactly one of two simultaneous claims win', async () => {
    const db = await aServer();
    const clock = movable(START);
    for (let round = 0; round < 25; round += 1) {
      await db
        .updateTable('setup_state')
        .set({
          claim_digest: null,
          claimed_at: null,
          claimed_by: null,
          claim_seen_at: null,
          step_reached: null,
          step_reached_at: null,
        })
        .where('id', '=', true)
        .execute();
      const { code } = await aStart(db, clock);
      const outcomes = await Promise.allSettled([
        claimSetup(db, code, 'browser-a', clock),
        claimSetup(db, code, 'browser-b', clock),
      ]);
      const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      expect(won).toHaveLength(1);
      const lost = outcomes.find((outcome) => outcome.status === 'rejected');
      expect(lost?.status === 'rejected' && lost.reason instanceof SetupRefused).toBe(true);
      expect(lost?.status === 'rejected' ? (lost.reason as SetupRefused).refusal : null).toEqual({
        reason: 'claimed',
      });
      // The loser is the one whose browser the row does not name.
      const winner = outcomes[0].status === 'fulfilled' ? 'browser-a' : 'browser-b';
      const row = await stateOf(db);
      expect(row.claimed_by).toBe(winner);
      const token = won[0]?.status === 'fulfilled' ? won[0].value.claimToken : '';
      expect(row.claim_digest).toBe(await tokenDigest(token));
      // Neither counts as a guess.
      expect(row.failed_attempts).toBe(0);
    }
  });
});

describe('integration: resuming (D-179 §4.2, Review Focus 5)', () => {
  test('resumes from the saved step with the same session', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    const { claimToken } = await claimSetup(db, code, 'browser-a', clock);
    const session = await requireSetupClaim(db, claimToken, clock);
    await recordStep(db, session, 'admin', clock);
    await recordStep(db, session, 'address', clock);
    // The browser closes; it comes back nearly a day later with its cookie.
    clock.advance(DAY_MS - 1);
    const again = await requireSetupClaim(db, claimToken, clock);
    expect(await stepsOf(db, again, clock)).toEqual(['claim', 'admin', 'address']);
    // And being seen moves the day along: another day less a moment, and it still opens.
    clock.advance(DAY_MS - 1);
    expect(await stepsOf(db, await requireSetupClaim(db, claimToken, clock), clock)).toEqual([
      'claim',
      'admin',
      'address',
    ]);
  });

  test('one refusal for a missing, a wrong, an idle and a taken-over token, and on a closed server', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    const { claimToken } = await claimSetup(db, code, 'browser-a', clock);
    const notClaimed: SetupRefusal = { reason: 'not-claimed' };

    expect(await refusalOf(requireSetupClaim(db, undefined, clock))).toEqual(notClaimed);
    expect(await refusalOf(requireSetupClaim(db, '', clock))).toEqual(notClaimed);
    expect(await refusalOf(requireSetupClaim(db, 'f'.repeat(64), clock))).toEqual(notClaimed);
    expect(await refusalOf(requireSetupClaim(db, await tokenDigest(claimToken), clock))).toEqual(
      notClaimed,
    );

    // Idle a whole day: it no longer opens.
    clock.advance(DAY_MS);
    expect(await refusalOf(requireSetupClaim(db, claimToken, clock))).toEqual(notClaimed);

    // A finished server is closed, and says so in the same words, to the token that held it too.
    const fresh = await aServer();
    const started = await aStart(fresh, clock);
    const kept = await claimSetup(fresh, started.code, 'browser-a', clock);
    await fresh
      .insertInto('server_settings')
      .values({ id: true, setup_completed_at: clock.now() })
      .execute();
    expect(await refusalOf(requireSetupClaim(fresh, kept.claimToken, clock))).toEqual(notClaimed);

    // The same error, word for word, whatever the reason.
    const messages = new Set<string>();
    for (const token of [undefined, 'nope', claimToken]) {
      try {
        await requireSetupClaim(db, token, clock);
      } catch (error) {
        messages.add(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      }
    }
    expect(messages.size).toBe(1);
  });

  test('a restart alone ends no claim: the browser holding it carries on', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    const { claimToken } = await claimSetup(db, code, 'browser-a', clock);
    await recordStep(db, await requireSetupClaim(db, claimToken, clock), 'admin', clock);
    await aStart(db, clock);
    expect(await stepsOf(db, await requireSetupClaim(db, claimToken, clock), clock)).toEqual([
      'claim',
      'admin',
    ]);
  });

  test('the code of a later start takes an unfinished setup over, at the step it reached; the first browser is refused from then on', async () => {
    const db = await aServer();
    const clock = movable(START);
    const first = await aStart(db, clock);
    const a = await claimSetup(db, first.code, 'browser-a', clock);
    const sessionA = await requireSetupClaim(db, a.claimToken, clock);
    await recordStep(db, sessionA, 'admin', clock);

    // Cookies cleared, another browser: the operator restarts the server, waits out the fifteen
    // minutes, and enters the new code.
    const second = await aStart(db, clock);
    clock.advance(SETUP_TAKEOVER_IDLE_MS);
    const b = await claimSetup(db, second.code, 'browser-b', clock);
    expect(b.steps).toEqual(['claim', 'admin']);
    expect(await refusalOf(requireSetupClaim(db, a.claimToken, clock))).toEqual({
      reason: 'not-claimed',
    });
    // A request of the first browser already past the guard writes nothing either.
    expect(await refusalOf(recordStep(db, sessionA, 'address', clock))).toEqual({
      reason: 'not-claimed',
    });
    const sessionB = await requireSetupClaim(db, b.claimToken, clock);
    await recordStep(db, sessionB, 'address', clock);
    expect(await stepsOf(db, sessionB, clock)).toEqual(['claim', 'admin', 'address']);
  });
});

describe('integration: the steps (D-179 §4.2)', () => {
  test('are passed in order, and passing one again changes nothing', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    const { claimToken } = await claimSetup(db, code, 'browser-a', clock);
    const session = await requireSetupClaim(db, claimToken, clock);

    expect(await refusalOf(recordStep(db, session, 'address', clock))).toEqual({
      reason: 'out-of-order',
    });
    await recordStep(db, session, 'admin', clock);
    const reachedAt = (await stateOf(db)).step_reached_at;
    clock.advance(60_000);
    // Again, and an earlier one: neither moves the record, forward or back.
    await recordStep(db, session, 'admin', clock);
    await recordStep(db, session, 'claim', clock);
    expect(await stepsOf(db, session, clock)).toEqual(['claim', 'admin']);
    expect((await stateOf(db)).step_reached_at).toEqual(reachedAt);
  });

  test('every step the wizard passes is one the database keeps', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    const { claimToken } = await claimSetup(db, code, 'browser-a', clock);
    const session = await requireSetupClaim(db, claimToken, clock);
    const passable = SETUP_STEPS.filter(
      (step): step is Exclude<SetupStep, 'finish'> => step !== 'finish',
    );
    for (const step of passable) await recordStep(db, session, step, clock);
    expect(await stepsOf(db, session, clock)).toEqual(passable);
    // `finish` is the finish rule's to write (Task 16's `finishSetup`); the column already takes it.
    await db.updateTable('setup_state').set({ step_reached: 'finish' }).execute();
    expect(await stepsOf(db, session, clock)).toEqual(SETUP_STEPS);
  });
});

describe('integration: the closed door (D-179 §4.8, design §7.14)', () => {
  /** Every function but the status refuses, and no code is written. */
  const expectClosed = async (
    db: Executor,
    clock: Clock,
    held: { code: string; claimToken: string } | undefined,
    holder: 'refused' | 'carries on' = 'refused',
  ): Promise<void> => {
    expect(await setupStatus(db)).toBe('closed');
    const { log, lines } = recording();
    await issueSetupCode(db, log, clock);
    expect(lines.filter((line) => line.includes(SETUP_CODE_LINE))).toEqual([]);
    expect(lines.filter((line) => line.includes(SETUP_CLOSED_LINE))).toHaveLength(1);
    // And what an unfinished setup left is cleared: no code is left to open anything.
    expect((await stateOf(db)).code_digest).toBeNull();
    expect(await refusalOf(claimSetup(db, held?.code ?? WRONG, 'browser-a', clock))).toEqual({
      reason: 'closed',
    });
    // Nobody without the claim gets anything: no token, a wrong one, a session that is not the claim's.
    expect(await refusalOf(requireSetupClaim(db, undefined, clock))).toEqual({
      reason: 'not-claimed',
    });
    expect(await refusalOf(requireSetupClaim(db, 'f'.repeat(64), clock))).toEqual({
      reason: 'not-claimed',
    });
    const stranger = { claimDigest: 'e'.repeat(64) };
    expect(await refusalOf(recordStep(db, stranger, 'admin', clock))).toEqual({ reason: 'closed' });
    expect(await refusalOf(stepsOf(db, stranger, clock))).toEqual({ reason: 'closed' });
    expect(await refusalOf(completeSetup(db, stranger, clock))).toEqual({ reason: 'closed' });
    if (held === undefined) return;
    const digest = await tokenDigest(held.claimToken);
    if (holder === 'refused') {
      // Nor does a session handed out before the door closed open anything.
      expect(await refusalOf(requireSetupClaim(db, held.claimToken, clock))).toEqual({
        reason: 'not-claimed',
      });
      expect(await refusalOf(recordStep(db, { claimDigest: digest }, 'admin', clock))).toEqual({
        reason: 'closed',
      });
      expect(await refusalOf(stepsOf(db, { claimDigest: digest }, clock))).toEqual({
        reason: 'closed',
      });
    } else {
      // Ruling R42: closed by other users only, the claim's holder may still reach the finish.
      const session = await requireSetupClaim(db, held.claimToken, clock);
      expect(session.claimDigest).toBe(digest);
      expect(await stepsOf(db, session, clock)).toContain('claim');
    }
  };

  test('is open on a server with no user', async () => {
    const db = await aServer();
    expect(await setupStatus(db)).toBe('open');
  });

  test('a server installed before this version — a user and no setup — is closed from its first start', async () => {
    const db = await aServer();
    const clock = movable(START);
    await aUserRow(db, 'already-here');
    await expectClosed(db, clock, undefined);
    expect((await stateOf(db)).code_digest).toBeNull();
  });

  test('is closed once a user exists, the code in hand and the claim made or not', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    const { claimToken } = await claimSetup(db, code, 'browser-a', clock);
    const second = await aStart(db, clock);
    await aUserRow(db, 'someone');
    await expectClosed(db, clock, { code: second.code, claimToken }, 'carries on');
  });

  test('the administrator this setup made does not close it; any other user does', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    const { claimToken } = await claimSetup(db, code, 'browser-a', clock);
    const admin = await aUserRow(db, 'admin');
    await db
      .updateTable('setup_state')
      .set({ admin_user_id: admin.userId })
      .where('id', '=', true)
      .execute();
    expect(await setupStatus(db)).toBe('open');
    await recordStep(db, await requireSetupClaim(db, claimToken, clock), 'admin', clock);

    await aUserRow(db, 'someone-else');
    await expectClosed(db, clock, { code, claimToken }, 'carries on');
  });

  test('is closed once the setup is finished', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    const { claimToken } = await claimSetup(db, code, 'browser-a', clock);
    await db
      .insertInto('server_settings')
      .values({ id: true, setup_completed_at: clock.now() })
      .execute();
    await expectClosed(db, clock, { code, claimToken });
  });
});

describe('integration: finishing (D-179 §4.5, §4.8)', () => {
  /** A setup claimed, its administrator made, and every step before `finish` passed. */
  const aSetupAtTheEnd = async (
    db: Executor,
    clock: Clock,
  ): Promise<{ claimToken: string; adminId: string }> => {
    const { code } = await aStart(db, clock);
    const { claimToken } = await claimSetup(db, code, 'browser-a', clock);
    const admin = await aUserRow(db, 'admin');
    await db
      .updateTable('setup_state')
      .set({ admin_user_id: admin.userId })
      .where('id', '=', true)
      .execute();
    const session = await requireSetupClaim(db, claimToken, clock);
    for (const step of SETUP_STEPS) {
      if (step !== 'finish') await recordStep(db, session, step, clock);
    }
    return { claimToken, adminId: admin.userId };
  };

  test('`finish` is never recorded as a step: the type refuses it, and so does the server', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { claimToken } = await aSetupAtTheEnd(db, clock);
    const session = await requireSetupClaim(db, claimToken, clock);
    // @ts-expect-error -- `finish` is written by `completeSetup` alone
    expect(await refusalOf(recordStep(db, session, 'finish', clock))).toEqual({
      reason: 'out-of-order',
    });
    expect((await stateOf(db)).step_reached).toBe('invite');
  });

  test('is refused before the last step', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    const { claimToken } = await claimSetup(db, code, 'browser-a', clock);
    const session = await requireSetupClaim(db, claimToken, clock);
    expect(await refusalOf(completeSetup(db, session, clock))).toEqual({ reason: 'out-of-order' });
    expect(await setupStatus(db)).toBe('open');
  });

  test('sets the finish, forgets the administrator, records `finish` and spends the claim, at once', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { claimToken } = await aSetupAtTheEnd(db, clock);
    await completeSetup(db, await requireSetupClaim(db, claimToken, clock), clock);
    const settings = await db
      .selectFrom('server_settings')
      .select('setup_completed_at')
      .where('id', '=', true)
      .executeTakeFirstOrThrow();
    expect(settings.setup_completed_at).toEqual(clock.now());
    const row = await stateOf(db);
    expect(row.step_reached).toBe('finish');
    expect(row.claim_digest).toBeNull();
    expect(row.admin_user_id).toBeNull();
    await expectClosedDoor(db, clock, claimToken);
  });

  test('a finished server stays closed when its settings row is lost: its administrator is a user like any other', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { claimToken } = await aSetupAtTheEnd(db, clock);
    await completeSetup(db, await requireSetupClaim(db, claimToken, clock), clock);
    await db.deleteFrom('server_settings').where('id', '=', true).execute();
    await expectClosedDoor(db, clock, claimToken);
    expect((await stateOf(db)).code_digest).toBeNull();
  });

  test('is one transaction: a failure part way leaves the setup unfinished and the claim held', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { claimToken } = await aSetupAtTheEnd(db, clock);
    // The second write of the two fails, as a lost connection would.
    await sql`create function refuse_finish() returns trigger language plpgsql as $$
      begin raise exception 'refused for the test'; end $$`.execute(db);
    await sql`create trigger refuse_finish before update on setup_state
      for each row when (new.step_reached = 'finish') execute function refuse_finish()`.execute(db);
    const session = await requireSetupClaim(db, claimToken, clock);
    const failed = await completeSetup(db, session, clock).then(
      () => 'finished',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failed).toContain('refused for the test');
    const settings = await db
      .selectFrom('server_settings')
      .select('setup_completed_at')
      .where('id', '=', true)
      .executeTakeFirst();
    expect(settings?.setup_completed_at ?? null).toBeNull();
    expect(await setupStatus(db)).toBe('open');
    expect(await stepsOf(db, await requireSetupClaim(db, claimToken, clock), clock)).toContain(
      'invite',
    );
  });

  test('a start of a server closed by users clears the code, the count and the lock, and keeps the holder’s claim (R42)', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    const { claimToken } = await claimSetup(db, code, 'browser-a', clock);
    await aStart(db, clock);
    await refusalOf(claimSetup(db, WRONG, 'browser-b', clock));
    await aUserRow(db, 'someone');
    const { log } = recording();
    await issueSetupCode(db, log, clock);
    expect(await stateOf(db)).toMatchObject({
      code_digest: null,
      code_issued_at: null,
      failed_attempts: 0,
      locked_until: null,
      claimed_by: 'browser-a',
      step_reached: 'claim',
    });
    expect(await stepsOf(db, await requireSetupClaim(db, claimToken, clock), clock)).toEqual([
      'claim',
    ]);
  });

  test('a start of a finished server clears every claim and step an unfinished setup left', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { code } = await aStart(db, clock);
    await claimSetup(db, code, 'browser-a', clock);
    await db
      .insertInto('server_settings')
      .values({ id: true, setup_completed_at: clock.now() })
      .execute();
    const { log } = recording();
    await issueSetupCode(db, log, clock);
    expect(await stateOf(db)).toMatchObject({
      code_digest: null,
      claim_digest: null,
      claimed_by: null,
      step_reached: null,
      step_reached_at: null,
    });
  });

  test('a session held when the finish is written elsewhere opens nothing more, before any restart', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { claimToken } = await aSetupAtTheEnd(db, clock);
    const session = await requireSetupClaim(db, claimToken, clock);
    // Written by another path — another node, a restored settings row — while this claim is held.
    await db
      .insertInto('server_settings')
      .values({ id: true, setup_completed_at: clock.now() })
      .execute();
    expect(await refusalOf(stepsOf(db, session, clock))).toEqual({ reason: 'closed' });
    expect(await refusalOf(recordStep(db, session, 'invite', clock))).toEqual({ reason: 'closed' });
    expect(await refusalOf(completeSetup(db, session, clock))).toEqual({ reason: 'closed' });
  });

  test('a start of a finished server keeps the record that it finished', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { claimToken } = await aSetupAtTheEnd(db, clock);
    await completeSetup(db, await requireSetupClaim(db, claimToken, clock), clock);
    const finishedAt = (await stateOf(db)).step_reached_at;
    clock.advance(60_000);
    const { log } = recording();
    await issueSetupCode(db, log, clock);
    expect(await stateOf(db)).toMatchObject({
      step_reached: 'finish',
      step_reached_at: finishedAt,
    });
  });

  test('the holder finishes though an invitee joined first; nobody else can do anything, and afterwards nobody at all (R42)', async () => {
    const db = await aServer();
    const clock = movable(START);
    const { claimToken } = await aSetupAtTheEnd(db, clock);
    await aUserRow(db, 'invitee');
    expect(await setupStatus(db)).toBe('closed');
    // Not the holder: refused, whatever it holds.
    const stranger = { claimDigest: 'e'.repeat(64) };
    expect(await refusalOf(completeSetup(db, stranger, clock))).toEqual({ reason: 'closed' });
    expect(await refusalOf(requireSetupClaim(db, 'f'.repeat(64), clock))).toEqual({
      reason: 'not-claimed',
    });
    // The holder: finishes, and both facts then hold.
    await completeSetup(db, await requireSetupClaim(db, claimToken, clock), clock);
    const settings = await db
      .selectFrom('server_settings')
      .select('setup_completed_at')
      .where('id', '=', true)
      .executeTakeFirstOrThrow();
    expect(settings.setup_completed_at).toEqual(clock.now());
    expect((await stateOf(db)).admin_user_id).toBeNull();
    await expectClosedDoor(db, clock, claimToken);
  });
});

/** A closed door, as every function sees it. */
const expectClosedDoor = async (db: Executor, clock: Clock, claimToken: string): Promise<void> => {
  expect(await setupStatus(db)).toBe('closed');
  const { log, lines } = recording();
  await issueSetupCode(db, log, clock);
  expect(lines.filter((line) => line.includes(SETUP_CODE_LINE))).toEqual([]);
  expect(await refusalOf(requireSetupClaim(db, claimToken, clock))).toEqual({
    reason: 'not-claimed',
  });
  expect(await refusalOf(claimSetup(db, WRONG, 'browser-b', clock))).toEqual({ reason: 'closed' });
};
