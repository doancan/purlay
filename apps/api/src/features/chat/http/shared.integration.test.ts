/** Real HTTP admission, query validation and the public Shared wire contract. */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { messageId, SharedPage } from '@purlay/types';
import { createApp } from '../../../ingress/http/app';
import { fixedClock } from '../../../platform/clock';
import { SESSION_COOKIE } from '../../../platform/cookies';
import { aRoom } from '../../../testing/rooms';
import { aSession } from '../../../testing/signed-in';
import { testDependencies } from '../../../testing/doubles';
import { sendMessage } from '../messages/messages';

afterAll(closeIntegrationDatabase);
const NOW = new Date('2026-11-11T12:00:00Z');
const clock = fixedClock(NOW);

describe('integration: Shared HTTP', () => {
  test('integration: Shared HTTP authenticates, validates bounded filters and sends only the public shape', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada']);
      const ada = room.members['ada'];
      if (ada === undefined) throw new Error('no writer');
      await sendMessage(db, clock, ada.context, {
        id: messageId(NOW),
        content: '[Policy](http://intranet/policy) https://example.com/new',
      });
      const { token } = await aSession(db, clock, ada.userId, 30);
      const app = createApp(testDependencies({ database: db, clock }));
      const path = `/api/workspaces/${room.workspaceId}/shared`;
      const get = (query: string, authenticated = true): Promise<Response> =>
        app.handle(
          new Request(`https://purlay.test${path}${query}`, {
            headers: authenticated ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
          }),
        );
      expect((await get('', false)).status).toBe(401);
      const files = await get('');
      expect(files.status).toBe(200);
      expect(await files.json()).toEqual({ data: [], nextCursor: null, indexing: false });
      const response = await get('?view=links&limit=1');
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      if (!Value.Check(SharedPage, body)) throw new Error('not a SharedPage');
      expect(body.data).toHaveLength(1);
      expect(body.nextCursor).not.toBeNull();
      const first = body.data[0];
      if (first?.kind !== 'link') throw new Error('not a shared link');
      expect(Object.keys(first).sort()).toEqual([
        'channelId',
        'key',
        'kind',
        'link',
        'messageId',
        'parentId',
        'sender',
        'sentAt',
        'sourceName',
      ]);
      for (const query of [
        '?limit=101',
        '?limit=1.5',
        '?view=unknown',
        '?view=links&type=pdf',
        '?since=2026-99-99T00:00:00Z',
        '?view=links&before=garbage',
        '?q=%00',
      ]) {
        const invalid = await get(query);
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
      }
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', ada.userId)
        .execute();
      expect((await get('?view=links')).status).toBe(404);
    });
  });

  test('integration: Shared HTTP preserves a guest post-join history floor', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'guest']);
      const ada = room.members['ada'],
        guest = room.members['guest'];
      if (ada === undefined || guest === undefined) throw new Error('incomplete room');
      await db
        .updateTable('workspace_members')
        .set({ access_kind: 'guest', guest_since: NOW, guest_modules: ['chat'] })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', guest.userId)
        .execute();
      await db
        .updateTable('channel_members')
        .set({ joined_at: NOW })
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', guest.userId)
        .execute();
      const past = new Date(NOW.getTime() - 60_000);
      await sendMessage(db, fixedClock(past), ada.context, {
        id: messageId(past),
        content: 'https://example.com/before',
      });
      await sendMessage(db, clock, ada.context, {
        id: messageId(NOW),
        content: 'https://example.com/after',
      });
      const { token } = await aSession(db, clock, guest.userId, 30);
      const app = createApp(testDependencies({ database: db, clock }));
      const response = await app.handle(
        new Request(`https://purlay.test/api/workspaces/${room.workspaceId}/shared?view=links`, {
          headers: { cookie: `${SESSION_COOKIE}=${token}` },
        }),
      );
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      if (!Value.Check(SharedPage, body)) throw new Error('not a SharedPage');
      expect(body.data.map((item) => (item.kind === 'link' ? item.link.url : ''))).toEqual([
        'https://example.com/after',
      ]);
    });
  });
});
