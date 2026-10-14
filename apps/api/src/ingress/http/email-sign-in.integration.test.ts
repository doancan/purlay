/**
 * `POST /auth/email` through the real app (#81, D-138): `202` whatever the address with the message
 * posted after the answer; `503 EMAIL_SIGN_IN_UNAVAILABLE` where mail is off — never a `202` that sends
 * nothing; the contract's refusal for what is not an address; and no line of the request's log with the
 * address or the link in it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import type { MailMessage, Outbox } from '../../platform/mail';
import { aRecordingLogger, testDependencies } from '../../testing/doubles';
import { SESSION_COOKIE } from '../../platform/cookies';
import { createApp } from './app';
import { SIGN_IN_REQUESTS_PER_HOUR } from './email-sign-in';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const APP = 'https://purlay.test';

/** An outbox that keeps what it was given, to read the link back. */
const aRecordingOutbox = (): Outbox & { readonly posted: MailMessage[] } => {
  const posted: MailMessage[] = [];
  return {
    posted,
    post: (message): void => {
      posted.push(message);
    },
    flush: () => Promise.resolve(),
  };
};

const ask = async (
  db: Executor,
  body: unknown,
  mail: Outbox | undefined,
  log = aRecordingLogger().log,
): Promise<Response> => {
  const app = createApp(
    testDependencies({ database: db, log, ...(mail === undefined ? {} : { mail }) }),
  );
  return await app.handle(
    new Request(`${APP}/auth/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: APP },
      body: JSON.stringify(body),
    }),
  );
};

const codeOf = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { error?: { code?: unknown } }).error?.code;

describe('integration: asking for a sign-in link over HTTP', () => {
  test('off without mail: 503, said, and nothing written', async () => {
    await withRollback(async (db) => {
      const response = await ask(db, { email: 'someone@example.test', locale: 'en' }, undefined);
      expect([response.status, await codeOf(response)]).toEqual([503, 'EMAIL_SIGN_IN_UNAVAILABLE']);
      expect(
        await db
          .selectFrom('email_sign_ins')
          .selectAll()
          .where('email', '=', 'someone@example.test')
          .execute(),
      ).toEqual([]);
    });
  });

  test('on: 202 with nothing in it, the message posted, and no log line holds the address or link', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const { log, lines } = aRecordingLogger();
      const response = await ask(db, { email: 'someone@example.test', locale: 'tr' }, mail, log);
      expect([response.status, await response.text()]).toEqual([202, '']);
      expect(mail.posted.map((message) => message.to)).toEqual(['someone@example.test']);
      // The request line is written after the response: waited for, as the thing expected.
      for (let waited = 0; !lines.some((line) => line['msg'] === 'request'); waited += 1) {
        if (waited > 100) throw new Error('the request was never logged');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const written = JSON.stringify(lines);
      expect(written).not.toContain('someone@example.test');
      expect(written).not.toContain('/sign-in/email#');
      // The control: the request was logged, so the absence above means something.
      expect(lines.some((line) => line['msg'] === 'request')).toBe(true);
    });
  });

  test('past the limit the answer is the same 202, and nothing more is posted', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      for (let n = 0; n < 6; n += 1) {
        expect((await ask(db, { email: 'busy@example.test', locale: 'en' }, mail)).status).toBe(
          202,
        );
      }
      expect(mail.posted).toHaveLength(5);
    });
  });

  test('one client past its links for the hour, across addresses: the same 202, and nothing sent', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const app = createApp(testDependencies({ database: db, mail }));
      const statuses: number[] = [];
      for (let n = 0; n <= SIGN_IN_REQUESTS_PER_HOUR; n += 1) {
        const response = await app.handle(
          new Request(`${APP}/auth/email`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: APP },
            body: JSON.stringify({ email: `person-${String(n)}@example.test`, locale: 'en' }),
          }),
        );
        statuses.push(response.status);
      }
      expect(new Set(statuses)).toEqual(new Set([202]));
      expect(mail.posted).toHaveLength(SIGN_IN_REQUESTS_PER_HOUR);
      expect(mail.posted.map((message) => message.to)).not.toContain(
        `person-${String(SIGN_IN_REQUESTS_PER_HOUR)}@example.test`,
      );
    });
  });

  test('what the contract refuses is refused: not an address, an unknown language, a field too many', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      for (const body of [
        { email: 'nobody', locale: 'en' },
        { email: 'a@example.test', locale: 'fr' },
        { email: 'a@example.test', locale: 'en', next: '/evil' },
        { email: `${'a'.repeat(250)}@example.test`, locale: 'en' },
      ]) {
        const response = await ask(db, body, mail);
        expect([response.status, await codeOf(response)]).toEqual([400, 'VALIDATION_FAILED']);
      }
      expect(mail.posted).toEqual([]);
    });
  });
});

describe('integration: using the link over HTTP', () => {
  const post = async (
    app: ReturnType<typeof createApp>,
    path: string,
    body: unknown,
    cookie?: string,
  ): Promise<Response> =>
    await app.handle(
      new Request(`${APP}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: APP,
          ...(cookie === undefined ? {} : { cookie }),
        },
        body: JSON.stringify(body),
      }),
    );

  test('asked, shown, used: a session cookie, which opens the API; used again, not found', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const { log, lines } = aRecordingLogger();
      const app = createApp(testDependencies({ database: db, mail, log }));
      expect(
        (await post(app, '/auth/email', { email: 'Newcomer@Example.test', locale: 'en' })).status,
      ).toBe(202);
      const token = /#([0-9a-f]{64})/.exec(mail.posted[0]?.text ?? '')?.[1] ?? '';
      expect(token).toHaveLength(64);

      const shown = await post(app, '/auth/email/preview', { token });
      expect([shown.status, await shown.json()]).toEqual([200, { email: 'newcomer@example.test' }]);

      const used = await post(app, '/auth/email/consume', { token });
      expect(used.status).toBe(204);
      const cookie = (used.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
      const me = await app.handle(new Request(`${APP}/api/me`, { headers: { cookie } }));
      expect(me.status).toBe(200);
      expect(((await me.json()) as { user: { email: string } }).user.email).toBe(
        'newcomer@example.test',
      );

      const again = await post(app, '/auth/email/consume', { token });
      expect([again.status, await codeOf(again)]).toEqual([404, 'SIGN_IN_LINK_NOT_FOUND']);
      // Every request line written, and none holds the token or the address.
      for (
        let waited = 0;
        lines.filter((line) => line['msg'] === 'request').length < 4;
        waited += 1
      ) {
        if (waited > 100) throw new Error('the requests were never logged');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(JSON.stringify(lines)).not.toContain(token);
      expect(JSON.stringify(lines)).not.toContain('newcomer@example.test');
    });
  });

  test('a token that is not one is the contract’s refusal; one that never was, not found', async () => {
    await withRollback(async (db) => {
      const app = createApp(testDependencies({ database: db }));
      for (const body of [{ token: 'short' }, { token: 'G'.repeat(64) }, {}]) {
        const response = await post(app, '/auth/email/consume', body);
        expect([response.status, await codeOf(response)]).toEqual([400, 'VALIDATION_FAILED']);
      }
      const unknown = await post(app, '/auth/email/preview', { token: 'a'.repeat(64) });
      expect([unknown.status, await codeOf(unknown)]).toEqual([404, 'SIGN_IN_LINK_NOT_FOUND']);
    });
  });
});
