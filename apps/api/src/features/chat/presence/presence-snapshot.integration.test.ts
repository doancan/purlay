/**
 * What a workspace's presence snapshot asks the online record about: the workspace's own people, and nobody who is in
 * another workspace only, however many people the record says are online.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { aRoom } from '../../../testing/rooms';
import { workspacePresence, type OnlineReader } from './presence';

afterAll(async () => {
  await closeIntegrationDatabase();
});

describe('integration: a workspace’s presence snapshot', () => {
  test('asks about this workspace’s people only', async () => {
    await withRollback(async (db) => {
      const here = await aRoom(db, ['alice', 'bob']);
      const there = await aRoom(db, ['carol']);
      const asked: string[] = [];
      const online: OnlineReader = {
        onlineAmong: (userIds) => {
          asked.push(...userIds);
          return Promise.resolve(
            userIds.map((userId) => ({ userId, online: true, away: false, version: 1 })),
          );
        },
        version: () => 1,
      };
      const alice = here.members['alice']?.userId ?? '';
      const context = await requireWorkspaceMembership(db, alice, here.workspaceId);
      const snapshot = await workspacePresence(db, context, online);
      const mine = [alice, here.members['bob']?.userId ?? ''].sort();
      expect([...asked].sort()).toEqual(mine);
      expect(snapshot.online.map((change) => change.userId).sort()).toEqual(mine);
      expect(asked).not.toContain(there.members['carol']?.userId ?? '');
    });
  });
});
