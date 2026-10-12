/**
 * The invitation endpoints over HTTP (`API.md` §3, D-115): the whole path a new teammate takes, what
 * each door refuses, and that the token never reaches the log — with the request line it would have
 * been on found first, so an empty log cannot pass for a clean one.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { createApp } from './app';
import { fixedClock } from '../../platform/clock';
import { NOW, aRecordingLogger, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
const ORIGIN = 'https://purlay.test';

const caller = (
  db: Executor,
  log = aRecordingLogger().log,
): ((method: string, path: string, who?: SignedInUser, body?: unknown) => Promise<Response>) => {
  const app = createApp(testDependencies({ database: db, clock, log }));
  return async (method, path, who, body) =>
    await app.handle(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          ...(who === undefined ? {} : { cookie: who.cookie }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
};

/** An owner's workspace and a link into it, made over HTTP. */
const aLink = async (
  db: Executor,
  call: ReturnType<typeof caller>,
  name: string,
): Promise<{ owner: SignedInUser; workspaceId: string; token: string }> => {
  const owner = await aSignedInUser(db, clock, `${name}-owner`);
  const created = await call('POST', '/api/workspaces', owner, {
    name,
    slug: aUniqueSlug(name),
  });
  const { id: workspaceId } = (await created.json()) as { id: string };
  const made = await call('POST', `/api/workspaces/${workspaceId}/invitations`, owner);
  expect(made.status).toBe(201);
  const { token } = (await made.json()) as { token: string };
  return { owner, workspaceId, token };
};

describe('integration: invitations over HTTP', () => {
  test('a new teammate previews the link, joins, and finds the workspace among their own', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const { workspaceId, token } = await aLink(db, call, 'ih-path');
      const newcomer = await aSignedInUser(db, clock, 'ih-newcomer');

      const preview = await call('POST', '/api/invitations/preview', newcomer, { token });
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({ workspace: { id: workspaceId }, member: false });
      const joined = await call('POST', '/api/invitations/accept', newcomer, { token });
      expect(joined.status).toBe(200);
      expect(await joined.json()).toMatchObject({ workspace: { id: workspaceId }, role: 'member' });

      const me = (await (await call('GET', '/api/me', newcomer)).json()) as {
        memberships: { workspace: { id: string } }[];
      };
      expect(me.memberships.map((m) => m.workspace.id)).toEqual([workspaceId]);
    });
  });

  test('a token that is not one is refused for its shape, naming the field, before anything is read', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const someone = await aSignedInUser(db, clock, 'ih-shape');
      for (const body of [
        { token: 'a'.repeat(63) },
        { token: 'a'.repeat(65) },
        { token: 'A'.repeat(64) },
        { token: 'a'.repeat(64), extra: true },
        {},
      ]) {
        for (const path of ['/api/invitations/preview', '/api/invitations/accept']) {
          const response = await call('POST', path, someone, body);
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
        }
      }
    });
  });

  test('without a session every door is 401; a link that does not open is 404', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const { workspaceId, token } = await aLink(db, call, 'ih-nosession');
      expect((await call('POST', '/api/invitations/preview', undefined, { token })).status).toBe(
        401,
      );
      expect((await call('POST', '/api/invitations/accept', undefined, { token })).status).toBe(
        401,
      );
      expect((await call('POST', `/api/workspaces/${workspaceId}/invitations`)).status).toBe(401);

      const someone = await aSignedInUser(db, clock, 'ih-unknown');
      const unknown = await call('POST', '/api/invitations/accept', someone, {
        token: 'f'.repeat(64),
      });
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({ error: { code: 'INVITATION_NOT_FOUND' } });
    });
  });

  test('revoking a link that is not an id, or not this workspace’s, is 404 — never a server error', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const { owner, workspaceId } = await aLink(db, call, 'ih-revoke');
      const theirs = await aLink(db, call, 'ih-revoke-other');
      const other = await call(
        'GET',
        `/api/workspaces/${theirs.workspaceId}/invitations`,
        theirs.owner,
      );
      const [link] = ((await other.json()) as { data: { id: string }[] }).data;
      if (link === undefined) throw new Error('no link listed');

      for (const id of ['not-a-uuid', link.id]) {
        const response = await call(
          'DELETE',
          `/api/workspaces/${workspaceId}/invitations/${id}`,
          owner,
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: 'INVITATION_NOT_FOUND' } });
      }
    });
  });

  test('the token is in no line the server writes — and the lines it would be in were written', async () => {
    await withRollback(async (db) => {
      const recorded = aRecordingLogger();
      const call = caller(db, recorded.log);
      const { token, workspaceId } = await aLink(db, call, 'ih-log');
      const newcomer = await aSignedInUser(db, clock, 'ih-log-newcomer');
      await call('POST', '/api/invitations/preview', newcomer, { token });
      await call('POST', '/api/invitations/accept', newcomer, { token });
      await call('POST', '/api/invitations/accept', newcomer, { token: `${token}0` });

      const paths = recorded.lines
        .filter((line) => line['msg'] === 'request')
        .map((line) => line['path']);
      expect(paths).toContain('/api/invitations/preview');
      expect(paths).toContain('/api/invitations/accept');
      expect(JSON.stringify(recorded.lines)).not.toContain(token);
      const trail = await db
        .selectFrom('audit_log')
        .select('metadata')
        .where('workspace_id', '=', workspaceId)
        .execute();
      expect(trail.length).toBeGreaterThan(0);
      expect(JSON.stringify(trail)).not.toContain(token);
    });
  });
});
