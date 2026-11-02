/**
 * The trail over HTTP, narrowed and downloaded (D-222): what the query may say and what it is told when
 * it says something else, the file's headers, and the download on the trail with the session that took
 * it (D-116). Who may is the permission table's (`testing/permissions.ts`); another workspace is the
 * cross-tenant suite's.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import type { AuditPage } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { recordAudit } from '../../modules/audit/audit';
import { NOW, testDependencies } from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { aSession } from '../../testing/signed-in';
import { createApp } from './app';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);

interface World {
  readonly room: Room;
  readonly sessionId: string;
  readonly get: (path: string, signedIn?: boolean) => Promise<Response>;
  readonly idOf: (name: string) => string;
}

const aWorld = async (db: Executor): Promise<World> => {
  const room = await aRoom(db, ['vedat', 'yasemin']);
  const idOf = (name: string): string => room.members[name]?.userId ?? '';
  const { token, sessionId } = await aSession(db, clock, idOf('vedat'), 1);
  const app = createApp(testDependencies({ database: db, clock }));
  return {
    room,
    sessionId,
    idOf,
    get: async (path, signedIn = true) =>
      await app.handle(
        new Request(`https://purlay.test/api/workspaces/${room.workspaceId}${path}`, {
          headers: signedIn ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
        }),
      ),
  };
};

const fieldsOf = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { error: { details?: { fields?: unknown } } }).error.details?.fields;

describe('integration: the trail narrowed over HTTP (D-222)', () => {
  test('pages within a filter by the cursor it answers with', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (let n = 0; n < 3; n += 1) {
        await recordAudit(db, fixedClock(new Date(NOW.getTime() - (n + 1) * 1_000)), {
          workspaceId: world.room.workspaceId,
          actorUserId: world.idOf(n === 1 ? 'vedat' : 'yasemin'),
          action: 'member.left',
          targetType: 'user',
          targetId: world.idOf('yasemin'),
        });
      }
      const filter = `actorId=${world.idOf('yasemin')}&action=member.left&limit=1`;
      const first = (await (await world.get(`/audit?${filter}`)).json()) as AuditPage;
      expect(first.data).toHaveLength(1);
      const second = (await (
        await world.get(`/audit?${filter}&before=${first.nextCursor ?? ''}`)
      ).json()) as AuditPage;
      expect(second.data.map((entry) => entry.actor?.id)).toEqual([world.idOf('yasemin')]);
      expect(second.nextCursor).toBeNull();
    });
  });

  test('a query it does not take is refused by the field, before anything is read or recorded', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const refusals: [string, string][] = [
        ['/audit?action=member.deleted', 'action'],
        ['/audit?actorId=vedat', 'actorId'],
        ['/audit?from=2026-10-31', 'from'],
        ['/audit?from=2026-10-31T00:00:00.000Z&to=2026-10-30T00:00:00.000Z', 'to'],
        ['/audit?colour=red', 'colour'],
        ['/audit/export', 'format'],
        ['/audit/export?format=xlsx', 'format'],
        ['/audit/export?format=csv&limit=10', 'limit'],
        ['/audit/export?format=csv&to=2026-02-30T00:00:00.000Z', 'to'],
        ['/audit/export?format=csv&format=ndjson', 'format'],
      ];
      for (const [path, field] of refusals) {
        const response = await world.get(path);
        expect({ path, status: response.status }).toEqual({ path, status: 400 });
        expect(Object.keys((await fieldsOf(response)) as object)).toContain(field);
      }
      const recorded = await db
        .selectFrom('audit_log')
        .select('id')
        .where('workspace_id', '=', world.room.workspaceId)
        .execute();
      expect(recorded).toEqual([]);
    });
  });

  test('signed out is 401 for the page and for the file', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect((await world.get('/audit', false)).status).toBe(401);
      expect((await world.get('/audit/export?format=csv', false)).status).toBe(401);
    });
  });
});

describe('integration: the trail downloaded over HTTP (D-222)', () => {
  test('is an attachment of its type, never cached, with the session that took it on the trail', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const csv = await world.get('/audit/export?format=csv&action=audit.exported');
      expect(csv.status).toBe(200);
      expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(csv.headers.get('content-disposition')).toMatch(
        /^attachment; filename="room-[a-z0-9-]+-audit-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
      expect(csv.headers.get('cache-control')).toBe('no-store');
      expect(csv.headers.get('x-content-type-options')).toBe('nosniff');
      // The download is on the trail before its first byte, so the file holds it.
      const text = await csv.text();
      expect(text.split('\r\n').filter((line) => line !== '')).toHaveLength(2);
      expect(text).toContain(`,audit.exported,${world.idOf('vedat')},`);

      const lines = await world.get('/audit/export?format=ndjson');
      expect(lines.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
      expect(lines.headers.get('content-disposition')).toEndWith('.ndjson"');
      expect((await lines.text()).trim().split('\n')).toHaveLength(2);

      const rows = await db
        .selectFrom('audit_log')
        .select(['action', 'session_id', 'metadata'])
        .where('workspace_id', '=', world.room.workspaceId)
        .execute();
      // Both at the test's one instant, so in no order of their own.
      expect(rows).toHaveLength(2);
      expect(rows).toContainEqual({
        action: 'audit.exported',
        session_id: world.sessionId,
        metadata: { format: 'csv', action: 'audit.exported' },
      });
      expect(rows).toContainEqual({
        action: 'audit.exported',
        session_id: world.sessionId,
        metadata: { format: 'ndjson' },
      });
    });
  });
});
