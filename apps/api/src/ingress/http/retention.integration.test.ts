/**
 * How long a workspace keeps its history, over HTTP (D-139 §4): forever until an owner says otherwise;
 * every change on the trail with what it was and what it became, and the same window again nothing;
 * whole days from the database's own floor to a hundred years, and nothing else; the floor bound to the
 * database's check, so the contract and the table cannot disagree. Who may is `permissions.ts`'s; which
 * workspace, `cross-tenant.ts`'s.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Transaction } from '@purlay/db';
import { RETENTION_DAYS_MAX, RETENTION_DAYS_MIN } from '@purlay/types';
import { NOW, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { aRoom } from '../../testing/rooms';
import { issueSession } from '../../modules/auth/sessions';
import { SESSION_COOKIE } from '../../platform/cookies';
import { attempt } from '../../testing/attempt';
import { createApp } from './app';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
const ORIGIN = 'https://purlay.test';

const owner = async (
  db: Transaction,
): Promise<{ workspaceId: string; cookie: string; app: ReturnType<typeof createApp> }> => {
  const room = await aRoom(db, ['ada']);
  const ada = room.members['ada'];
  if (ada === undefined) throw new Error('no ada');
  await db
    .updateTable('workspace_members')
    .set({ role: 'owner' })
    .where('workspace_id', '=', room.workspaceId)
    .where('user_id', '=', ada.userId)
    .execute();
  const { token } = await issueSession(db, clock, ada.userId, 30);
  return {
    workspaceId: room.workspaceId,
    cookie: `${SESSION_COOKIE}=${token}`,
    app: createApp(testDependencies({ database: db, clock })),
  };
};

const call = async (
  app: ReturnType<typeof createApp>,
  method: 'GET' | 'PUT',
  workspaceId: string,
  cookie: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> => {
  const response = await app.handle(
    new Request(`${ORIGIN}/api/workspaces/${workspaceId}/retention`, {
      method,
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, json: await response.json() };
};

const changes = async (db: Transaction, workspaceId: string): Promise<unknown[]> =>
  (
    await db
      .selectFrom('audit_log')
      .select('metadata')
      .where('workspace_id', '=', workspaceId)
      .where('action', '=', 'retention.changed')
      .execute()
  ).map((row) => row.metadata);

describe('integration: how long a workspace keeps its history', () => {
  test('forever until set; each change on the trail; the same window again writes nothing', async () => {
    await withRollback(async (db) => {
      const { workspaceId, cookie, app } = await owner(db);
      expect(await call(app, 'GET', workspaceId, cookie)).toEqual({
        status: 200,
        json: { retentionDays: null },
      });
      expect(await call(app, 'PUT', workspaceId, cookie, { retentionDays: 90 })).toEqual({
        status: 200,
        json: { retentionDays: 90 },
      });
      await call(app, 'PUT', workspaceId, cookie, { retentionDays: 90 });
      await call(app, 'PUT', workspaceId, cookie, { retentionDays: null });
      expect(await call(app, 'GET', workspaceId, cookie)).toEqual({
        status: 200,
        json: { retentionDays: null },
      });
      // Both at the test's one instant, so their ids do not order them: compared as a set.
      const said = (trail: readonly unknown[]): string[] =>
        trail
          .map((entry) => {
            const { from, to } = entry as { from?: unknown; to?: unknown };
            return `${String(from)} -> ${String(to)}`;
          })
          .sort();
      expect(said(await changes(db, workspaceId))).toEqual(
        said([
          { from: 'forever', to: '90' },
          { from: '90', to: 'forever' },
        ]),
      );
    });
  });

  test('whole days from the floor to a hundred years, and nothing else', async () => {
    await withRollback(async (db) => {
      const { workspaceId, cookie, app } = await owner(db);
      for (const retentionDays of [RETENTION_DAYS_MIN, RETENTION_DAYS_MAX]) {
        expect((await call(app, 'PUT', workspaceId, cookie, { retentionDays })).status).toBe(200);
      }
      for (const retentionDays of [
        RETENTION_DAYS_MIN - 1,
        RETENTION_DAYS_MAX + 1,
        RETENTION_DAYS_MIN + 0.5,
        String(RETENTION_DAYS_MIN),
        0,
      ]) {
        const refused = await call(app, 'PUT', workspaceId, cookie, { retentionDays });
        expect(refused.status).toBe(400);
        expect(refused.json).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
      }
      expect((await call(app, 'PUT', workspaceId, cookie, {})).status).toBe(400);
    });
  });

  test('the contract’s floor is the database’s: one below is refused by the table too', async () => {
    await withRollback(async (db) => {
      const { workspaceId } = await owner(db);
      const write = async (days: number): Promise<void> => {
        await db
          .updateTable('workspaces')
          .set({ retention_days: days })
          .where('id', '=', workspaceId)
          .execute();
      };
      expect(await attempt(db, () => write(RETENTION_DAYS_MIN))).toBe('taken');
      expect(await attempt(db, () => write(RETENTION_DAYS_MIN - 1))).toContain(
        'retention_days_sane',
      );
    });
  });
});
