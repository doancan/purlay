/**
 * Who hears that somebody came online (#480, D-136), against the database: the people who share a
 * workspace with them, and nobody else — not a stranger, not somebody removed a moment ago, not the
 * person themselves. A workspace's presence is its members online, at the version said.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import type { PresenceChange, ServerFrame } from '@purlay/types';
import { aMovableClock } from '../../testing/doubles';
import { userTopic, type EventBus } from '../../platform/events';
import { createLogger } from '../../platform/logging';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { aRoom, type Room } from '../../testing/rooms';
import { announcePresence, workspacePresence } from './presence';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = aMovableClock(new Date('2026-10-14T12:00:00.000Z'));
const log = createLogger({ level: 'silent' });

const idOf = (room: Room, name: string): string => {
  const person = room.members[name] ?? room.outsiders[name];
  if (person === undefined) throw new Error(`no ${name}`);
  return person.userId;
};

/** A bus that records what each person's own topic carries: what their sockets would hear. */
const listening = (
  db: Executor,
): {
  readonly heard: (userId: string) => PresenceChange[];
  readonly announce: (change: PresenceChange) => Promise<void>;
} => {
  const published: [string, ServerFrame][] = [];
  const bus: EventBus = {
    publish: (topic, frame): Promise<void> => {
      published.push([topic, frame]);
      return Promise.resolve();
    },
    subscribe: () => false,
    unsubscribe: () => undefined,
    forget: () => undefined,
  };
  return {
    heard: (userId) =>
      published.flatMap(([topic, frame]) =>
        topic === userTopic(userId) && frame.event === 'PRESENCE' ? frame.data.changes : [],
      ),
    announce: async (change): Promise<void> => {
      await announcePresence({ database: db, bus, clock, log }, change);
    },
  };
};

describe('integration: who hears that somebody came online', () => {
  test('everybody who shares a workspace with them, once; never they themselves', async () => {
    await withRollback(async (db) => {
      const here = await aRoom(db, ['alice', 'bob'], { outsiders: ['erin'] });
      const alice = idOf(here, 'alice');
      const node = listening(db);
      const change = { userId: alice, online: true, version: 7 };
      await node.announce(change);
      expect(node.heard(idOf(here, 'bob'))).toEqual([change]);
      // In the workspace, not in the channel: presence is the workspace's, not a channel's.
      expect(node.heard(idOf(here, 'erin'))).toEqual([change]);
      expect(node.heard(alice)).toEqual([]);
    });
  });

  test('a stranger hears nothing — though their socket hears their own workspace', async () => {
    await withRollback(async (db) => {
      const here = await aRoom(db, ['alice', 'bob']);
      const there = await aRoom(db, ['carol', 'dave']);
      const carol = idOf(there, 'carol');
      const node = listening(db);
      await node.announce({ userId: idOf(here, 'alice'), online: true, version: 1 });
      expect(node.heard(carol)).toEqual([]);
      // The control: the same socket does hear somebody she shares a workspace with.
      const dave = { userId: idOf(there, 'dave'), online: true, version: 2 };
      await node.announce(dave);
      expect(node.heard(carol)).toEqual([dave]);
    });
  });

  test('somebody removed from the workspace a moment ago hears nothing more', async () => {
    await withRollback(async (db) => {
      const here = await aRoom(db, ['alice', 'bob']);
      const bob = idOf(here, 'bob');
      const node = listening(db);
      await node.announce({ userId: idOf(here, 'alice'), online: true, version: 1 });
      expect(node.heard(bob)).toHaveLength(1);
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', here.workspaceId)
        .where('user_id', '=', bob)
        .execute();
      await node.announce({ userId: idOf(here, 'alice'), online: false, version: 2 });
      expect(node.heard(bob)).toHaveLength(1);
    });
  });

  test('a workspace’s presence is its members online, and the version everyone else is offline at', async () => {
    await withRollback(async (db) => {
      const here = await aRoom(db, ['alice', 'bob']);
      const alice = idOf(here, 'alice');
      const elsewhere = await aRoom(db, ['carol']);
      const context = await requireWorkspaceMembership(db, idOf(here, 'bob'), here.workspaceId);
      let version = 10;
      const online = new Map([
        [alice, 3],
        [idOf(elsewhere, 'carol'), 4],
      ]);
      const snapshot = await workspacePresence(db, context, {
        onlineAmong: (userIds) =>
          Promise.resolve(
            userIds.flatMap((userId) => {
              const at = online.get(userId);
              return at === undefined ? [] : [{ userId, online: true, version: at }];
            }),
          ),
        version: () => (version += 1),
      });
      // Carol is online, and in no workspace of Bob's: not in his.
      expect(snapshot).toEqual({
        online: [{ userId: alice, online: true, version: 3 }],
        version: 11,
      });
    });
  });
});
