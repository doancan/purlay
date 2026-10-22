/**
 * Sign-in links at the same instant, on a cloned database with real connections — inside the
 * harness's single transaction nothing races (D-46, D-77). A trigger that sleeps holds each window
 * open, so the outcome is not left to scheduling.
 *
 * - Many requests for one address at once still send five messages an hour (D-138 §7).
 * - One link spent from two tabs at once signs in once (D-138 §4: once).
 * - Two links to one new address spent at once are two sign-ins and one account (D-78).
 * - Two new addresses wanting one name at once both sign in, under two names (D-138 §5).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, sql, type ClonedDatabase } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { aRecordingLogger, aRecordingOutbox, NOW, testDependencies } from '../../testing/doubles';
import { installShutdown } from '../../lifecycle';
import { SIGN_IN_LINKS_PER_HOUR } from '../../modules/auth/magic-link';
import { createApp } from './app';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  await sql`
    create function hold_window() returns trigger language plpgsql as
    $$ begin perform pg_sleep(0.3); return new; end $$
  `.execute(cloned.db);
  await sql`
    create function hold_long() returns trigger language plpgsql as
    $$ begin perform pg_sleep(1); return new; end $$
  `.execute(cloned.db);
});

afterAll(async () => {
  await cloned.drop();
});

const APP = 'https://purlay.test';

const post = (path: string, body: unknown): Request =>
  new Request(`${APP}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: APP },
    body: JSON.stringify(body),
  });

const anApp = (): {
  app: ReturnType<typeof createApp>;
  mail: ReturnType<typeof aRecordingOutbox>;
} => {
  const mail = aRecordingOutbox();
  const app = createApp(
    testDependencies({ database: cloned.db, clock: fixedClock(NOW), mail, signUp: 'open' }),
  );
  return { app, mail };
};

/** A link asked for, and what it came to — decided after the answer — waited for. */
const ask = async (app: ReturnType<typeof createApp>, body: unknown): Promise<Response> => {
  const response = await app.handle(post('/auth/email', body));
  await app.settled();
  return response;
};

const tokensIn = (mail: ReturnType<typeof aRecordingOutbox>): string[] =>
  mail.posted.map((message) => /#([0-9a-f]{64})/.exec(message.text)?.[1] ?? '');

/** Runs `body` with a sleep before every insert into `table`, and takes it away after. */
const held = async <T>(
  table: 'users' | 'rate_limits' | 'verifications',
  body: () => Promise<T>,
  hold: 'hold_window' | 'hold_long' = 'hold_window',
): Promise<T> => {
  await sql`create trigger hold before insert on ${sql.table(table)} for each row execute function ${sql.raw(hold)}()`.execute(
    cloned.db,
  );
  try {
    return await body();
  } finally {
    await sql`drop trigger hold on ${sql.table(table)}`.execute(cloned.db);
  }
};

const sessionsOf = async (email: string): Promise<{ accounts: number; sessions: number }> => {
  const accounts = await cloned.db
    .selectFrom('users')
    .select('id')
    .where('email', '=', email)
    .execute();
  const sessions = await cloned.db
    .selectFrom('sessions')
    .select('id')
    .where(
      'user_id',
      'in',
      accounts.map((account) => account.id),
    )
    .execute();
  return { accounts: accounts.length, sessions: sessions.length };
};

describe('integration: sign-in links at the same instant', () => {
  test('every request for one address is answered 202, and five messages are sent', async () => {
    const { app, mail } = anApp();
    const email = `race-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const answers = await held(
      'rate_limits',
      async () =>
        await Promise.all(
          Array.from(
            { length: SIGN_IN_LINKS_PER_HOUR + 2 },
            async () => await ask(app, { email, locale: 'en' }),
          ),
        ),
    );
    expect(answers.map((answer) => answer.status)).toEqual(
      Array.from({ length: SIGN_IN_LINKS_PER_HOUR + 2 }, () => 202),
    );
    expect(mail.posted).toHaveLength(SIGN_IN_LINKS_PER_HOUR);
    const rows = await cloned.db
      .selectFrom('verifications')
      .select('id')
      .where('value', 'like', `%${email}%`)
      .execute();
    expect(rows).toHaveLength(SIGN_IN_LINKS_PER_HOUR);
  });

  test('one link spent from two tabs at once signs in once', async () => {
    const { app, mail } = anApp();
    const email = `twice-${crypto.randomUUID().slice(0, 8)}@example.test`;
    expect((await ask(app, { email, locale: 'en' })).status).toBe(202);
    const [token] = tokensIn(mail);
    const answers = await held(
      'users',
      async () =>
        await Promise.all(
          [0, 1].map(async () => await app.handle(post('/auth/email/consume', { token }))),
        ),
    );
    expect(answers.map((answer) => answer.status).sort()).toEqual([204, 404]);
    expect(await sessionsOf(email)).toEqual({ accounts: 1, sessions: 1 });
  });

  test('two links to one new address spent at once: both sign in, one account, a session each', async () => {
    const { app, mail } = anApp();
    const email = `pair-${crypto.randomUUID().slice(0, 8)}@example.test`;
    for (let n = 0; n < 2; n += 1) {
      expect((await ask(app, { email, locale: 'en' })).status).toBe(202);
    }
    const tokens = tokensIn(mail);
    expect(tokens.map((token) => token.length)).toEqual([64, 64]);
    const answers = await held(
      'users',
      async () =>
        await Promise.all(
          tokens.map(async (token) => await app.handle(post('/auth/email/consume', { token }))),
        ),
    );
    expect(answers.map((answer) => answer.status)).toEqual([204, 204]);
    expect(await sessionsOf(email)).toEqual({ accounts: 1, sessions: 2 });
  });

  test('two new addresses wanting one name at once: both sign in, under the name and the next', async () => {
    const { app, mail } = anApp();
    const local = `twin-${crypto.randomUUID().slice(0, 8)}`;
    for (const domain of ['a.test', 'b.test']) {
      expect((await ask(app, { email: `${local}@${domain}`, locale: 'en' })).status).toBe(202);
    }
    const tokens = tokensIn(mail);
    const answers = await held(
      'users',
      async () =>
        await Promise.all(
          tokens.map(async (token) => await app.handle(post('/auth/email/consume', { token }))),
        ),
    );
    expect(answers.map((answer) => answer.status)).toEqual([204, 204]);
    const names = await cloned.db
      .selectFrom('users')
      .select('username')
      .where('email', 'in', [`${local}@a.test`, `${local}@b.test`])
      .orderBy('username')
      .execute();
    expect(names.map((row) => row.username)).toEqual([local, `${local}-1`]);
  });

  test('an account’s answer waits for nothing its link costs: the 202 comes before the link is made', async () => {
    const { app, mail } = anApp();
    const email = `known-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await cloned.db
      .insertInto('users')
      .values({
        email,
        username: email.slice(0, email.indexOf('@')),
        display_name: 'Known',
        email_verified: true,
      })
      .execute();
    // Making the link's row takes a second; the answer must not.
    const took = await held(
      'verifications',
      async () => {
        const started = performance.now();
        const response = await app.handle(post('/auth/email', { email, locale: 'en' }));
        const ms = performance.now() - started;
        expect(response.status).toBe(202);
        expect(mail.posted).toEqual([]);
        await app.settled();
        return ms;
      },
      'hold_long',
    );
    expect(took).toBeLessThan(500);
    expect(mail.posted.map((message) => message.to)).toEqual([email]);
  });

  /** A promise the test resolves by hand. */
  const aGate = (): { readonly opened: Promise<void>; readonly open: () => void } => {
    let open = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  };

  /**
   * `users` held by another transaction, so nothing can read an account until the test lets go:
   * whatever waits on it is shown to be waiting. Returns how to let go.
   */
  const accountsHeld = async (): Promise<() => Promise<void>> => {
    const [taken, release] = [aGate(), aGate()];
    const holding = cloned.db.transaction().execute(async (transaction) => {
      await sql`lock table users in access exclusive mode`.execute(transaction);
      taken.open();
      await release.opened;
    });
    await taken.opened;
    return async () => {
      release.open();
      await holding;
    };
  };

  /** The answer, or `'no answer'` if none came within two seconds. */
  const answerWithin = async (pending: Promise<Response>): Promise<Response | 'no answer'> =>
    await Promise.race([
      pending,
      new Promise<'no answer'>((resolve) =>
        setTimeout(() => {
          resolve('no answer');
        }, 2_000),
      ),
    ]);

  /** An app that has served once already, so nothing it builds on first use reads under the hold. */
  const aWarmApp = async (): Promise<ReturnType<typeof anApp>> => {
    const warm = anApp();
    await ask(warm.app, {
      email: `warm-${crypto.randomUUID().slice(0, 8)}@example.test`,
      locale: 'en',
    });
    warm.mail.posted.length = 0;
    return warm;
  };

  const aKnownAccount = async (): Promise<string> => {
    const email = `held-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await cloned.db
      .insertInto('users')
      .values({
        email,
        username: email.slice(0, email.indexOf('@')),
        display_name: 'Held',
        email_verified: true,
      })
      .execute();
    return email;
  };

  test('the 202 comes while the account cannot be read; the link is made once it can', async () => {
    const { app, mail } = await aWarmApp();
    const email = await aKnownAccount();
    const letGo = await accountsHeld();
    let answered: Response | 'no answer';
    try {
      answered = await answerWithin(app.handle(post('/auth/email', { email, locale: 'en' })));
      expect(mail.posted).toEqual([]);
    } finally {
      await letGo();
    }
    expect(answered === 'no answer' ? answered : answered.status).toBe(202);
    await app.settled();
    expect(mail.posted.map((message) => message.to)).toEqual([email]);
  });

  test('a shutdown drains the link still being made, and only then flushes mail and closes the pool', async () => {
    const { app, mail } = await aWarmApp();
    const email = await aKnownAccount();
    const steps: string[] = [];
    const letGo = await accountsHeld();
    let shutdown: Promise<void> | undefined;
    try {
      expect((await app.handle(post('/auth/email', { email, locale: 'en' }))).status).toBe(202);
      shutdown = installShutdown({
        drain: app.drain,
        closeDatabase: () => {
          steps.push(
            `mail flushed and the pool closed, ${String(mail.posted.length)} message(s) out`,
          );
          return Promise.resolve();
        },
        log: aRecordingLogger().log,
        process: {
          on: () => undefined,
          exit: (code) => {
            steps.push(`exit ${String(code)}`);
          },
        },
        deadlineMs: 10_000,
      })('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 200));
      // The link cannot be made yet, so the drain has not finished.
      expect(steps).toEqual([]);
    } finally {
      await letGo();
    }
    await shutdown;
    expect(steps).toEqual(['mail flushed and the pool closed, 1 message(s) out', 'exit 0']);
  });
});
