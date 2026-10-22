/**
 * The setup administrator's own address check (D-179 §4.3, Ruling R32): a link of the wizard's own —
 * never the library's magic link — issued under the claim, kept as a digest, opening once and for a
 * day, and still opening after the setup is finished, from any browser. And the wizard's e-mail step
 * whole: the relay tried with the candidate settings by sending this very letter.
 *
 * On a database of each test's own (`cloneIntegrationDatabase`), as the setup's other tests are.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, closeIntegrationDatabase, sql, type Executor } from '@purlay/db';
import { DAY_MS, type Clock } from '../../platform/clock';
import { createLogger, type Logger } from '../../platform/logging';
import { smtpTransport } from '../../platform/mail';
import { tokenDigest } from '../../platform/tokens';
import { aScriptedRelay } from '../../testing/smtp-relay';
import { aUserRow } from '../../testing/users';
import { probeSmtp } from './probes';
import {
  claimSetup,
  completeSetup,
  issueSetupCode,
  recordStep,
  requireSetupClaim,
  SetupRefused,
  type SetupSession,
} from './setup';
import {
  ADMIN_VERIFICATION_TTL_MS,
  adminVerificationLetter,
  issueAdminVerification,
  sweepAdminVerification,
  VerificationRefused,
  verifyAdminEmail,
} from './verification';

type KyselyPlugin = Parameters<Executor['withPlugin']>[0];

/** Every `FOR UPDATE` taken out of the queries an executor runs: the lock removed, to see what else holds. */
const withoutRowLocks: KyselyPlugin = {
  transformQuery: ({ node }) =>
    node.kind === 'SelectQueryNode' && node.endModifiers !== undefined
      ? {
          ...node,
          endModifiers: node.endModifiers.filter((modifier) => modifier.modifier !== 'ForUpdate'),
        }
      : node,
  transformResult: async ({ result }) => await Promise.resolve(result),
};

/** Waits until another connection is blocked on a lock in a statement matching `statement`. */
const blockedOn = async (db: Executor, statement: RegExp): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await sql<{ query: string }>`select query from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`.execute(db);
    if (waiting.rows.some((row) => statement.test(row.query))) return;
    await Bun.sleep(20);
  }
  throw new Error(`nothing came to wait on a lock in ${String(statement)}`);
};

const clones: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(
    clones.map(async (drop) => {
      await drop();
    }),
  );
  await closeIntegrationDatabase();
});

const APP_URL = 'https://chat.example.com';

interface MovableClock extends Clock {
  readonly advance: (ms: number) => void;
}
const movable = (start = '2026-10-22T09:00:00.000Z'): MovableClock => {
  let now = new Date(start).getTime();
  return {
    now: () => new Date(now),
    advance: (ms): void => {
      now += ms;
    },
  };
};

const recording = (): { log: Logger; lines: string[] } => {
  const lines: string[] = [];
  return { log: createLogger({ level: 'debug', write: (line) => lines.push(line) }), lines };
};

/**
 * A fresh server, claimed by this browser, its administrator made: an unverified account recorded as
 * the setup's, at the `admin` step — the state `createAdmin` leaves (`admin.integration.test.ts`
 * holds how it gets there).
 */
const aServerWithItsAdmin = async (
  clock: Clock,
): Promise<{ db: Executor; session: SetupSession; admin: { userId: string; email: string } }> => {
  const clone = await cloneIntegrationDatabase();
  clones.push(clone.drop);
  const db = clone.db;
  const { log, lines } = recording();
  await issueSetupCode(db, log, clock);
  const code = lines
    .map((line) => JSON.parse(line) as { setupCode?: unknown })
    .map((line) => line.setupCode)
    .find((value): value is string => typeof value === 'string');
  if (code === undefined) throw new Error('no setup code was written');
  const { claimToken } = await claimSetup(db, code, 'browser-1', clock);
  const session = await requireSetupClaim(db, claimToken, clock);
  const admin = await aUserRow(db, 'ada');
  await db
    .updateTable('setup_state')
    .set({ admin_user_id: admin.userId, step_reached: 'admin', step_reached_at: clock.now() })
    .where('id', '=', true)
    .execute();
  await db
    .updateTable('users')
    .set({ is_server_admin: true })
    .where('id', '=', admin.userId)
    .execute();
  return { db, session, admin: { userId: admin.userId, email: admin.email } };
};

/** A message body as the mailbox shows it: quoted-printable's soft breaks and escapes undone. */
const quotedPrintable = (data: string): string =>
  data
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

const verifiedOf = async (db: Executor, userId: string): Promise<boolean> =>
  (
    await db
      .selectFrom('users')
      .select('email_verified')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()
  ).email_verified;

const pending = async (
  db: Executor,
): Promise<{ user_id: string; token_digest: string; issued_at: Date }[]> =>
  await db
    .selectFrom('admin_email_verification')
    .select(['user_id', 'token_digest', 'issued_at'])
    .where('id', '=', true)
    .execute();

describe('integration: the administrator’s address check (D-179 §4.3, R32)', () => {
  test('a link issued under the claim, followed, verifies the administrator’s address, once', async () => {
    const clock = movable();
    const { db, session, admin } = await aServerWithItsAdmin(clock);
    const issued = await issueAdminVerification(db, session, { clock });
    expect(issued.email).toBe(admin.email);
    expect(await verifiedOf(db, admin.userId)).toBe(false);

    expect(await verifyAdminEmail(db, issued.token, clock)).toBe('verified');
    expect(await verifiedOf(db, admin.userId)).toBe(true);
    // Spent: the second time is the refusal every other failure is.
    expect(await verifyAdminEmail(db, issued.token, clock)).toBe('refused');
    expect(await pending(db)).toEqual([]);
  });

  test('opens for a day from its issue, and not a moment past it', async () => {
    const early = movable();
    const one = await aServerWithItsAdmin(early);
    const first = await issueAdminVerification(one.db, one.session, { clock: early });
    early.advance(ADMIN_VERIFICATION_TTL_MS - 1);
    expect(await verifyAdminEmail(one.db, first.token, early)).toBe('verified');

    const late = movable();
    const two = await aServerWithItsAdmin(late);
    const second = await issueAdminVerification(two.db, two.session, { clock: late });
    late.advance(ADMIN_VERIFICATION_TTL_MS);
    expect(ADMIN_VERIFICATION_TTL_MS).toBe(DAY_MS);
    expect(await verifyAdminEmail(two.db, second.token, late)).toBe('refused');
    expect(await verifiedOf(two.db, two.admin.userId)).toBe(false);
  });

  test('a link issued "in the future" — a clock moved back — does not open', async () => {
    const clock = movable();
    const { db, session, admin } = await aServerWithItsAdmin(clock);
    const issued = await issueAdminVerification(db, session, { clock });
    clock.advance(-60_000);
    expect(await verifyAdminEmail(db, issued.token, clock)).toBe('refused');
    expect(await verifiedOf(db, admin.userId)).toBe(false);
  });

  test('a wrong token is refused as an unknown, a spent and an expired one are, and spends nothing', async () => {
    const clock = movable();
    const { db, session, admin } = await aServerWithItsAdmin(clock);
    const issued = await issueAdminVerification(db, session, { clock });
    const wrong = `${issued.token.slice(0, -1)}${issued.token.endsWith('0') ? '1' : '0'}`;
    const outcomes = [
      await verifyAdminEmail(db, wrong, clock),
      await verifyAdminEmail(db, '', clock),
      await verifyAdminEmail(db, 'not even hex', clock),
    ];
    expect(outcomes).toEqual(['refused', 'refused', 'refused']);
    // The right one still opens: a guess cannot spend the administrator's link.
    expect(await verifyAdminEmail(db, issued.token, clock)).toBe('verified');
    expect(await verifiedOf(db, admin.userId)).toBe(true);
  });

  test('a new link replaces the one before it: the old one is dead, the new one opens', async () => {
    const clock = movable();
    const { db, session, admin } = await aServerWithItsAdmin(clock);
    const old = await issueAdminVerification(db, session, { clock });
    const fresh = await issueAdminVerification(db, session, { clock });
    expect(fresh.token).not.toBe(old.token);
    expect(await pending(db)).toHaveLength(1);
    expect(await verifyAdminEmail(db, old.token, clock)).toBe('refused');
    expect(await verifyAdminEmail(db, fresh.token, clock)).toBe('verified');
    expect(await verifiedOf(db, admin.userId)).toBe(true);
  });

  test('keeps only the token’s digest, never the token, and the token carries 256 bits', async () => {
    const clock = movable();
    const { db, session, admin } = await aServerWithItsAdmin(clock);
    const issued = await issueAdminVerification(db, session, { clock });
    expect(issued.token).toMatch(/^[0-9a-f]{64}$/);
    const [row] = await pending(db);
    expect(row?.user_id).toBe(admin.userId);
    expect(row?.token_digest).toBe(await tokenDigest(issued.token));
    expect(row?.token_digest).not.toBe(issued.token);
    expect(row?.issued_at).toEqual(clock.now());
  });

  test('still opens after the setup is finished — the administrator forgotten, the claim spent — from any browser', async () => {
    const clock = movable();
    const { db, session, admin } = await aServerWithItsAdmin(clock);
    const issued = await issueAdminVerification(db, session, { clock });
    for (const step of ['address', 'policy', 'github', 'email', 'workspace', 'invite'] as const) {
      await recordStep(db, session, step, clock);
    }
    await completeSetup(db, session, clock);
    const state = await db
      .selectFrom('setup_state')
      .select(['admin_user_id', 'claim_digest'])
      .where('id', '=', true)
      .executeTakeFirstOrThrow();
    expect(state).toEqual({ admin_user_id: null, claim_digest: null });
    clock.advance(ADMIN_VERIFICATION_TTL_MS - 60_000);
    expect(await verifyAdminEmail(db, issued.token, clock)).toBe('verified');
    expect(await verifiedOf(db, admin.userId)).toBe(true);
  });

  test('two clicks of the one link at once verify once', async () => {
    const clock = movable();
    const { db, session } = await aServerWithItsAdmin(clock);
    const issued = await issueAdminVerification(db, session, { clock });
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, async () => await verifyAdminEmail(db, issued.token, clock)),
    );
    expect(outcomes.filter((outcome) => outcome === 'verified')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'refused')).toHaveLength(4);
  });

  test('an account erased since, or gone, verifies nothing', async () => {
    const clock = movable();
    const erased = await aServerWithItsAdmin(clock);
    const link = await issueAdminVerification(erased.db, erased.session, { clock });
    await erased.db
      .updateTable('users')
      .set({ deleted_at: clock.now() })
      .where('id', '=', erased.admin.userId)
      .execute();
    expect(await verifyAdminEmail(erased.db, link.token, clock)).toBe('refused');
    expect(await verifiedOf(erased.db, erased.admin.userId)).toBe(false);

    const deleted = await aServerWithItsAdmin(clock);
    await issueAdminVerification(deleted.db, deleted.session, { clock });
    await deleted.db.deleteFrom('users').where('id', '=', deleted.admin.userId).execute();
    // The row goes with the account's (`ON DELETE CASCADE`).
    expect(await pending(deleted.db)).toEqual([]);
  });

  test('is issued only under the claim, only for the setup’s administrator, only while unverified', async () => {
    const clock = movable();
    const { db, session, admin } = await aServerWithItsAdmin(clock);
    const refusal = async (promise: Promise<unknown>): Promise<string> => {
      try {
        await promise;
      } catch (error) {
        if (error instanceof SetupRefused || error instanceof VerificationRefused) {
          return error.refusal.reason;
        }
        throw error;
      }
      throw new Error('expected a refusal');
    };
    expect(
      await refusal(issueAdminVerification(db, { claimDigest: '0'.repeat(64) }, { clock })),
    ).toBe('not-claimed');
    await db
      .updateTable('users')
      .set({ email_verified: true })
      .where('id', '=', admin.userId)
      .execute();
    expect(await refusal(issueAdminVerification(db, session, { clock }))).toBe('already-verified');
    await db
      .updateTable('setup_state')
      .set({ admin_user_id: null })
      .where('id', '=', true)
      .execute();
    expect(await refusal(issueAdminVerification(db, session, { clock }))).toBe('no-admin');
    expect(await pending(db)).toEqual([]);
  });
});

describe('integration: one click of a link, when another holds it (review, fix round 1)', () => {
  /**
   * Another transaction holds the row; a click starts and is shown to wait where `statement` says; the
   * holder spends the link and commits; the click must then be refused. Deterministic: nothing here
   * depends on which of two racing clicks the database happened to run first.
   */
  const aClickBehindAHolder = async (
    statement: RegExp,
    clicking: (db: Executor) => Executor,
  ): Promise<{ outcome: string; verified: boolean }> => {
    const clock = movable();
    const { db, session, admin } = await aServerWithItsAdmin(clock);
    const issued = await issueAdminVerification(db, session, { clock });
    let click: Promise<'verified' | 'refused'> | undefined;
    await db.transaction().execute(async (holder) => {
      await holder
        .selectFrom('admin_email_verification')
        .select('id')
        .where('id', '=', true)
        .forUpdate()
        .executeTakeFirstOrThrow();
      click = verifyAdminEmail(clicking(db), issued.token, clock);
      await blockedOn(db, statement);
      await holder.deleteFrom('admin_email_verification').where('id', '=', true).execute();
    });
    return { outcome: (await click) ?? 'none', verified: await verifiedOf(db, admin.userId) };
  };

  test('the click waits on the row’s lock, and finds the link spent', async () => {
    expect(await aClickBehindAHolder(/for update/i, (db) => db)).toEqual({
      outcome: 'refused',
      verified: false,
    });
  });

  test('without the lock, the delete still decides: a click that deleted nothing verifies nothing', async () => {
    expect(
      await aClickBehindAHolder(/delete from "admin_email_verification"/i, (db) =>
        db.withPlugin(withoutRowLocks),
      ),
    ).toEqual({ outcome: 'refused', verified: false });
  });
});

describe('integration: what a link is bound to, and how long it is kept (review, fix round 1)', () => {
  test('a link is for the address it was sent to: changed since, it verifies nothing', async () => {
    const clock = movable();
    const { db, session, admin } = await aServerWithItsAdmin(clock);
    const issued = await issueAdminVerification(db, session, { clock });
    await db
      .updateTable('users')
      .set({ email: `changed-${admin.email}` })
      .where('id', '=', admin.userId)
      .execute();
    expect(await verifyAdminEmail(db, issued.token, clock)).toBe('refused');
    expect(await verifiedOf(db, admin.userId)).toBe(false);
  });

  test('keeps the address it was sent to, as stored', async () => {
    const clock = movable();
    const { db, session, admin } = await aServerWithItsAdmin(clock);
    await issueAdminVerification(db, session, { clock });
    const row = await db
      .selectFrom('admin_email_verification')
      .select('email')
      .where('id', '=', true)
      .executeTakeFirstOrThrow();
    expect(row.email).toBe(admin.email);
  });

  test('an expired link is deleted when it is tried, and by the daily sweep when it is not', async () => {
    const clock = movable();
    const tried = await aServerWithItsAdmin(clock);
    const issued = await issueAdminVerification(tried.db, tried.session, { clock });
    clock.advance(ADMIN_VERIFICATION_TTL_MS);
    expect(await verifyAdminEmail(tried.db, issued.token, clock)).toBe('refused');
    expect(await pending(tried.db)).toEqual([]);

    const later = movable();
    const swept = await aServerWithItsAdmin(later);
    await issueAdminVerification(swept.db, swept.session, { clock: later });
    later.advance(ADMIN_VERIFICATION_TTL_MS - 1);
    expect(await sweepAdminVerification(swept.db, later)).toBe(0);
    expect(await pending(swept.db)).toHaveLength(1);
    later.advance(1);
    expect(await sweepAdminVerification(swept.db, later)).toBe(1);
    expect(await pending(swept.db)).toEqual([]);
  });
});

describe('integration: the e-mail step whole — the candidate relay tried with the administrator’s letter (R47)', () => {
  test('the relay is sent the letter, and the link in what it received verifies the address', async () => {
    const clock = movable();
    const { db, session, admin } = await aServerWithItsAdmin(clock);
    const relay = await aScriptedRelay({ login: { user: 'mailer', pass: 'relay-pass' } });
    try {
      const issued = await issueAdminVerification(db, session, { clock });
      const letter = adminVerificationLetter({
        to: issued.email,
        appUrl: APP_URL,
        token: issued.token,
        locale: 'en',
      });
      const result = await probeSmtp(
        session,
        {
          smtpUrl: `smtp://mailer:relay-pass@127.0.0.1:${String(relay.port)}`,
          from: 'purlay@chat.example.com',
          allowPlaintext: false,
        },
        letter,
        { transportFactory: smtpTransport, timeoutMs: 5_000 },
      );
      expect(result).toEqual({ ok: true });
      expect(relay.received.map((message) => message.to)).toEqual([[admin.email]]);
      // The token as the mailbox has it: in the link's fragment.
      const mailed = /\/setup\/verify#([0-9a-f]{64})/.exec(
        quotedPrintable(relay.received[0]?.data ?? ''),
      )?.[1];
      expect(mailed).toBe(issued.token);
      // Nothing was saved by the try: the settings are not the probe's.
      expect(
        await db.selectFrom('server_settings').select('id').where('id', '=', true).execute(),
      ).toEqual([]);
      expect(await verifyAdminEmail(db, mailed ?? '', clock)).toBe('verified');
    } finally {
      await relay.stop();
    }
  });
});
