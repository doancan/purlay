/** Workspace-wide Shared reads use the same source authority and keyset bounds as the conversation. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { messageId, type SharedQuery } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { aRoom } from '../../../testing/rooms';
import { sendMessage } from '../messages/messages';
import { reviseMessage } from '../messages/edit';
import { sharedIn } from './shared';

afterAll(closeIntegrationDatabase);
const NOW = new Date('2026-11-11T12:00:00Z');
const clock = fixedClock(NOW);

describe('integration: workspace Shared links', () => {
  test('new and edited messages are indexed in their write and readable through Shared', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      const ada = room.members['ada'];
      const bob = room.members['bob'];
      if (ada === undefined || bob === undefined) throw new Error('incomplete room');
      const id = messageId(NOW);
      await sendMessage(db, clock, ada.context, {
        id,
        content: '[Order](http://erp/order/42) https://example.com/policy',
      });
      const scope = await requireWorkspaceMembership(db, bob.userId, room.workspaceId);
      const first = await sharedIn(db, scope, { view: 'links' });
      expect(first.data).toHaveLength(2);
      expect(first.indexing).toBe(true);
      await reviseMessage(db, clock, ada.userId, id, '[New policy](https://example.com/new)');
      const after = await sharedIn(db, scope, { view: 'links' });
      expect(after.data.map((item) => (item.kind === 'link' ? item.link.url : ''))).toEqual([
        'https://example.com/new',
      ]);
    });
  });
  test('private and cross-workspace content never contributes a row or cursor', async () => {
    await withRollback(async (db) => {
      const hidden = await aRoom(db, ['ada'], { type: 'private', outsiders: ['bob'] });
      const other = await aRoom(db, ['elsewhere']);
      const ada = hidden.members['ada'];
      const bob = hidden.outsiders['bob'];
      const writer = other.members['elsewhere'];
      if (ada === undefined || bob === undefined || writer === undefined)
        throw new Error('incomplete room');
      await sendMessage(db, clock, ada.context, {
        id: messageId(NOW),
        content: 'https://secret.example/private',
      });
      await sendMessage(db, clock, writer.context, {
        id: messageId(NOW),
        content: 'https://secret.example/other-workspace',
      });
      const context = await requireWorkspaceMembership(db, bob.userId, hidden.workspaceId);
      expect(await sharedIn(db, context, { view: 'links', limit: 1 })).toEqual({
        data: [],
        nextCursor: null,
        indexing: false,
      });
    });
  });
  test('a message with many links pages without requiring the previous cursor row to survive', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada']);
      const ada = room.members['ada'];
      if (ada === undefined) throw new Error('no writer');
      const id = messageId(NOW);
      await sendMessage(db, clock, ada.context, {
        id,
        content: 'https://example.com/a https://example.com/b https://example.com/c',
      });
      const context = await requireWorkspaceMembership(db, ada.userId, room.workspaceId);
      const query: SharedQuery = { view: 'links', limit: 1 };
      const first = await sharedIn(db, context, query);
      expect(first.data).toHaveLength(1);
      const item = first.data[0];
      if (item?.kind !== 'link' || first.nextCursor === null)
        throw new Error('expected a link cursor');
      await reviseMessage(
        db,
        clock,
        ada.userId,
        id,
        ['https://example.com/a', 'https://example.com/b', 'https://example.com/c']
          .filter((url) => url !== item.link.url)
          .join(' '),
      );
      const second = await sharedIn(db, context, { ...query, before: first.nextCursor });
      expect(second.data).toHaveLength(1);
      expect(second.data[0]).not.toEqual(item);
    });
  });
});
