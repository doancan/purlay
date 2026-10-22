/**
 * Inviting by e-mail over HTTP (D-179 §5): the answer a request gets, that the letters follow it and
 * wait for nothing, that a relay that is down or slow changes nothing about it and says nothing of the
 * address or the link when it fails, who may ask, and that the limits outlive the process.
 *
 * On a database of its own, with real connections: a failed transaction must be seen to end.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, sql, type ClonedDatabase } from '@purlay/db';
import { INVITATION_EMAILS_PER_REQUEST, type CreatedInvitation } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { outbox, type MailMessage, type Outbox } from '../../platform/mail';
import { NOW, aRecordingLogger, aRecordingOutbox, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { createApp } from './app';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});
afterAll(async () => {
  await cloned.drop();
});

const clock = fixedClock(NOW);
const ORIGIN = 'https://purlay.test';

type App = ReturnType<typeof createApp>;

const anApp = (mail?: Outbox, log = aRecordingLogger().log): App =>
  createApp(
    testDependencies({
      database: cloned.db,
      clock,
      log,
      ...(mail === undefined ? {} : { mail }),
    }),
  );

const call = async (
  app: App,
  method: string,
  path: string,
  who: SignedInUser,
  body?: unknown,
): Promise<Response> =>
  await app.handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        cookie: who.cookie,
        origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

/** An owner and their workspace, made over HTTP. */
const aWorkspace = async (app: App, name: string): Promise<{ owner: SignedInUser; id: string }> => {
  const owner = await aSignedInUser(cloned.db, clock, `${name}-own`);
  const made = await call(app, 'POST', '/api/workspaces', owner, {
    name,
    slug: aUniqueSlug(name),
  });
  return { owner, id: ((await made.json()) as { id: string }).id };
};

const invite = async (
  app: App,
  who: SignedInUser,
  workspaceId: string,
  body?: unknown,
): Promise<Response> =>
  await call(app, 'POST', `/api/workspaces/${workspaceId}/invitations`, who, body);

const never = (): Promise<void> => new Promise(() => undefined);

const codeOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

const counters = async (): Promise<number> => {
  const { rows } = await sql<{ n: number }>`
    select count(*)::int as n from rate_limits where key like 'purlay:invite-mail:%'
  `.execute(cloned.db);
  return rows[0]?.n ?? 0;
};

describe('integration: inviting by e-mail over HTTP', () => {
  test('201 with the link and, for each address, queued — and the letters follow, one link in each', async () => {
    const mail = aRecordingOutbox();
    const app = anApp(mail);
    const { owner, id } = await aWorkspace(app, 'im-sends');
    const response = await invite(app, owner, id, {
      emails: ['ann@example.test', 'Bob@Example.test'],
      locale: 'tr',
    });
    expect(response.status).toBe(201);
    const made = (await response.json()) as CreatedInvitation;
    expect(made.mail).toEqual([
      { address: 'ann@example.test', outcome: 'queued' },
      { address: 'bob@example.test', outcome: 'queued' },
    ]);
    await app.settled();
    expect(mail.posted.map((letter) => letter.to)).toEqual([
      'ann@example.test',
      'bob@example.test',
    ]);
    for (const letter of mail.posted) {
      expect(letter.text).toContain(`${ORIGIN}/invite#${made.token}`);
      expect(letter.subject).toBe('Purlay’a davet edildin');
    }
    // One link for the request, not one for each address.
    const links = await cloned.db
      .selectFrom('workspace_invitations')
      .select('id')
      .where('workspace_id', '=', id)
      .execute();
    expect(links).toHaveLength(1);
  });

  test('with no body, or an empty one, it is the link alone and no letter', async () => {
    const mail = aRecordingOutbox();
    const app = anApp(mail);
    const { owner, id } = await aWorkspace(app, 'im-plain');
    for (const body of [undefined, {}]) {
      const response = await invite(app, owner, id, body);
      expect(response.status).toBe(201);
      expect(((await response.json()) as CreatedInvitation).mail).toBeUndefined();
    }
    await app.settled();
    expect(mail.posted).toEqual([]);
  });

  test('on a server with no relay each address says unavailable, nothing is posted, and the link is there', async () => {
    const app = anApp();
    const { owner, id } = await aWorkspace(app, 'im-nomail');
    const response = await invite(app, owner, id, { emails: ['ann@example.test'] });
    expect(response.status).toBe(201);
    const made = (await response.json()) as CreatedInvitation;
    expect(made.mail).toEqual([{ address: 'ann@example.test', outcome: 'unavailable' }]);
    expect(made.token).toMatch(/^[0-9a-f]{64}$/);
  });

  test('more than twenty addresses in one request is refused before anything is made', async () => {
    const mail = aRecordingOutbox();
    const app = anApp(mail);
    const { owner, id } = await aWorkspace(app, 'im-many');
    const response = await invite(app, owner, id, {
      emails: Array.from(
        { length: INVITATION_EMAILS_PER_REQUEST + 1 },
        (_, n) => `a${String(n)}@example.test`,
      ),
    });
    expect([response.status, await codeOf(response)]).toEqual([400, 'VALIDATION_FAILED']);
    await app.settled();
    expect(mail.posted).toEqual([]);
    const links = await cloned.db
      .selectFrom('workspace_invitations')
      .select('id')
      .where('workspace_id', '=', id)
      .execute();
    expect(links).toEqual([]);
  });

  test('a body the contract does not know is refused, whoever sent it', async () => {
    const app = anApp(aRecordingOutbox());
    const { owner, id } = await aWorkspace(app, 'im-shape');
    for (const body of [{ emails: 'ann@example.test' }, { role: 'admin' }, { emails: [1] }]) {
      expect((await invite(app, owner, id, body)).status).toBe(400);
    }
  });

  test('a member is refused and mails nothing; an outsider does not find the workspace; neither is counted', async () => {
    const mail = aRecordingOutbox();
    const app = anApp(mail);
    const { owner, id } = await aWorkspace(app, 'im-who');
    const member = await aSignedInUser(cloned.db, clock, 'im-who-member');
    await cloned.db
      .insertInto('workspace_members')
      .values({ workspace_id: id, user_id: member.userId, role: 'member' })
      .execute();
    const rival = await aWorkspace(app, 'im-rival');
    const before = await counters();

    const asMember = await invite(app, member, id, { emails: ['ann@example.test'] });
    expect([asMember.status, await codeOf(asMember)]).toEqual([403, 'FORBIDDEN']);
    // Another workspace's owner, an admin there, is nobody here: tenant isolation.
    const asRival = await invite(app, rival.owner, id, { emails: ['ann@example.test'] });
    expect([asRival.status, await codeOf(asRival)]).toEqual([404, 'WORKSPACE_NOT_FOUND']);
    await app.settled();

    expect(mail.posted).toEqual([]);
    expect(await counters()).toBe(before);
    // The owner still can.
    expect((await invite(app, owner, id, { emails: ['ann@example.test'] })).status).toBe(201);
  });

  test('a relay that never answers delays nothing: the answer comes, the letters are on their way', async () => {
    const sending: MailMessage[] = [];
    const log = aRecordingLogger();
    const app = anApp(
      outbox((message) => {
        sending.push(message);
        return never();
      }, log.log),
      log.log,
    );
    const { owner, id } = await aWorkspace(app, 'im-hang');
    const started = performance.now();
    const response = await invite(app, owner, id, {
      emails: ['ann@example.test', 'bob@example.test'],
    });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(response.status).toBe(201);
    expect(((await response.json()) as CreatedInvitation).mail?.map((m) => m.outcome)).toEqual([
      'queued',
      'queued',
    ]);
    // The application's own work is done; what waits is the relay, which shutdown bounds (`flush`).
    await app.settled();
    expect(sending).toHaveLength(2);
  });

  test('a relay that refuses is logged by its code alone — no address, no link — and the link was answered', async () => {
    const log = aRecordingLogger();
    let token = '';
    const app = anApp(
      outbox(
        (message) =>
          Promise.reject(
            Object.assign(new Error(`550 5.1.1 <${message.to}> rejected; body held ${token}`), {
              code: 'EENVELOPE',
            }),
          ),
        log.log,
      ),
      log.log,
    );
    const { owner, id } = await aWorkspace(app, 'im-refused');
    const response = await invite(app, owner, id, { emails: ['secret.person@example.test'] });
    expect(response.status).toBe(201);
    const made = (await response.json()) as CreatedInvitation;
    token = made.token;
    expect(made.mail).toEqual([{ address: 'secret.person@example.test', outcome: 'queued' }]);
    expect(made.token).toMatch(/^[0-9a-f]{64}$/);
    await app.settled();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const failures = log.lines.filter((line) => line['msg'] === 'mail could not be sent');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ purpose: 'invitation', reason: 'EENVELOPE' });
    const written = JSON.stringify(log.lines);
    expect(written).not.toContain('secret.person');
    expect(written).not.toContain(made.token);
    expect(written).not.toContain('example.test>');
  });

  test('an outbox that throws as it is handed a letter is the log’s to say, redacted: the answer is the link, not a 500', async () => {
    const log = aRecordingLogger();
    const app = anApp(
      {
        post: (message) => {
          throw Object.assign(new Error(`could not queue for ${message.to}: ${message.text}`), {
            code: 'EQUEUE',
          });
        },
        flush: () => Promise.resolve(),
      },
      log.log,
    );
    const { owner, id } = await aWorkspace(app, 'im-throws');
    const response = await invite(app, owner, id, { emails: ['hidden.person@example.test'] });
    expect(response.status).toBe(201);
    const made = (await response.json()) as CreatedInvitation;
    expect(made.token).toMatch(/^[0-9a-f]{64}$/);
    await app.settled();
    const failures = log.lines.filter(
      (line) => line['msg'] === 'work left for after an answer failed',
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ purpose: 'invitation', reason: 'EQUEUE' });
    const written = JSON.stringify(log.lines);
    expect(written).not.toContain('hidden.person');
    expect(written).not.toContain(made.token);
  });

  test('a request that fails writes no letter and spends nothing', async () => {
    const mail = aRecordingOutbox();
    const app = anApp(mail);
    const { owner, id } = await aWorkspace(app, 'im-fails');
    const before = await counters();
    await sql`
      create function refuse_audit() returns trigger language plpgsql as
      $$ begin raise exception 'audit refused'; end $$
    `.execute(cloned.db);
    await sql`create trigger refuse before insert on audit_log for each row execute function refuse_audit()`.execute(
      cloned.db,
    );
    let response: Response;
    try {
      response = await invite(app, owner, id, { emails: ['ann@example.test'] });
    } finally {
      await sql`drop trigger refuse on audit_log`.execute(cloned.db);
      await sql`drop function refuse_audit()`.execute(cloned.db);
    }
    expect(response.status).toBe(500);
    await app.settled();
    expect(mail.posted).toEqual([]);
    expect(await counters()).toBe(before);
    const links = await cloned.db
      .selectFrom('workspace_invitations')
      .select('id')
      .where('workspace_id', '=', id)
      .execute();
    expect(links).toEqual([]);
  });

  test('the daily limit is in the database: a second process, a restart, finds the first one’s count', async () => {
    const first = aRecordingOutbox();
    const { owner, id } = await aWorkspace(anApp(first), 'im-restart');
    const one = anApp(first);
    for (const prefix of ['a', 'b']) {
      const response = await invite(one, owner, id, {
        emails: Array.from({ length: 20 }, (_, n) => `${prefix}${String(n)}@example.test`),
      });
      expect(response.status).toBe(201);
    }
    // A new application over the same database, as after a restart.
    const second = aRecordingOutbox();
    const restarted = anApp(second);
    const response = await invite(restarted, owner, id, {
      emails: Array.from({ length: 20 }, (_, n) => `c${String(n)}@example.test`),
    });
    const made = (await response.json()) as CreatedInvitation;
    expect([
      made.mail?.filter((m) => m.outcome === 'queued').length,
      made.mail?.filter((m) => m.outcome === 'inviter_limit').length,
    ]).toEqual([10, 10]);
    await restarted.settled();
    expect(second.posted).toHaveLength(10);
  });
});
