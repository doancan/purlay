/**
 * Who hears that somebody came online (#480, D-136), against the database: the people who share a
 * workspace with them, and the person themselves, whose own avatar shows their own state (D-257) —
 * nobody else: not a stranger, not somebody removed a moment ago. A workspace's presence is its
 * members online, at the version said.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import type { PresenceChange, ServerFrame } from '@purlay/types';
import { aMovableClock } from '../../../testing/doubles';
import { userTopic, type EventBus } from '../../../platform/events';
import { createLogger } from '../../../platform/logging';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { aRoom, type Room } from '../../../testing/rooms';
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
  test('a guest sees and hears only people in currently shared conversations', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest', 'expired-speaker'], {
        outsiders: ['unshared'],
      });
      const guestId = idOf(room, 'guest');
      const ownerId = idOf(room, 'owner');
      const now = new Date();
      await db
        .updateTable('workspace_members')
        .set({
          access_kind: 'guest',
          guest_since: new Date(now.getTime() - 60_000),
          guest_modules: ['chat'],
        })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', guestId)
        .execute();
      const expiredSpeaker = idOf(room, 'expired-speaker');
      await db
        .updateTable('workspace_members')
        .set({
          access_kind: 'guest',
          guest_since: new Date(now.getTime() - 60_000),
          guest_expires_at: new Date(now.getTime() - 1_000),
          guest_modules: ['chat'],
        })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', expiredSpeaker)
        .execute();
      const guest = await requireWorkspaceMembership(db, guestId, room.workspaceId);
      const online = {
        version: (): number => 1,
        onlineAmong: (ids: readonly string[]): Promise<readonly PresenceChange[]> =>
          Promise.resolve(ids.map((userId) => ({ userId, online: true, away: false, version: 1 }))),
      };
      expect(
        (await workspacePresence(db, guest, online)).online.map((row) => row.userId).sort(),
      ).toEqual([guestId, ownerId].sort());
      const node = listening(db);
      await node.announce({ userId: expiredSpeaker, online: true, away: false, version: 1 });
      expect(node.heard(guestId)).toEqual([]);
      await node.announce({
        userId: room.outsiders['unshared']?.userId ?? '',
        online: true,
        away: false,
        version: 1,
      });
      expect(node.heard(guestId)).toEqual([]);
      await node.announce({ userId: ownerId, online: true, away: false, version: 2 });
      expect(node.heard(guestId)).toHaveLength(1);
      await db
        .updateTable('workspace_members')
        .set({ guest_expires_at: new Date(now.getTime() - 1_000) })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', guestId)
        .execute();
      await node.announce({ userId: ownerId, online: false, away: false, version: 3 });
      expect(node.heard(guestId)).toHaveLength(1);
      expect((await workspacePresence(db, guest, online)).online).toEqual([]);
    });
  });

  test('everybody who shares a workspace with them, once, and they themselves (D-257)', async () => {
    await withRollback(async (db) => {
      const here = await aRoom(db, ['alice', 'bob'], { outsiders: ['erin'] });
      const alice = idOf(here, 'alice');
      const node = listening(db);
      const change = { userId: alice, online: true, away: false, version: 7 };
      await node.announce(change);
      expect(node.heard(idOf(here, 'bob'))).toEqual([change]);
      // In the workspace, not in the channel: presence is the workspace's, not a channel's.
      expect(node.heard(idOf(here, 'erin'))).toEqual([change]);
      // Her own state, on her own topic: every page of hers draws her own avatar from it, and her
      // menu reads whether the away is her choice from it.
      expect(node.heard(alice)).toEqual([{ ...change, chosen: false }]);
    });
  });

  test('a stranger hears nothing — though their socket hears their own workspace', async () => {
    await withRollback(async (db) => {
      const here = await aRoom(db, ['alice', 'bob']);
      const there = await aRoom(db, ['carol', 'dave']);
      const carol = idOf(there, 'carol');
      const node = listening(db);
      const alice = { userId: idOf(here, 'alice'), online: true, away: false, version: 1 };
      await node.announce(alice);
      expect(node.heard(carol)).toEqual([]);
      // Telling Alice herself reaches nobody new.
      expect(node.heard(idOf(here, 'alice'))).toEqual([{ ...alice, chosen: false }]);
      // The control: the same socket does hear somebody she shares a workspace with.
      const dave = { userId: idOf(there, 'dave'), online: true, away: false, version: 2 };
      await node.announce(dave);
      expect(node.heard(carol)).toEqual([dave]);
    });
  });

  test('somebody removed from the workspace a moment ago hears nothing more', async () => {
    await withRollback(async (db) => {
      const here = await aRoom(db, ['alice', 'bob']);
      const bob = idOf(here, 'bob');
      const node = listening(db);
      await node.announce({ userId: idOf(here, 'alice'), online: true, away: false, version: 1 });
      expect(node.heard(bob)).toHaveLength(1);
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', here.workspaceId)
        .where('user_id', '=', bob)
        .execute();
      await node.announce({ userId: idOf(here, 'alice'), online: false, away: false, version: 2 });
      expect(node.heard(bob)).toHaveLength(1);
      // The control: the change was told, to Alice herself.
      expect(node.heard(idOf(here, 'alice'))).toHaveLength(2);
    });
  });

  test('the person’s own choice is added to what is told, and never to an offline change (D-257)', async () => {
    await withRollback(async (db) => {
      const here = await aRoom(db, ['alice', 'bob']);
      const alice = idOf(here, 'alice');
      const bob = idOf(here, 'bob');
      const node = listening(db);
      await node.announce({ userId: alice, online: true, away: false, version: 1 });
      await db.updateTable('users').set({ away_chosen: true }).where('id', '=', alice).execute();
      // Read as it is told: the change after the choice is away, though the node told it active.
      await node.announce({ userId: alice, online: true, away: false, version: 2 });
      await node.announce({ userId: alice, online: false, away: false, version: 3 });
      expect(node.heard(bob)).toEqual([
        { userId: alice, online: true, away: false, version: 1 },
        { userId: alice, online: true, away: true, version: 2 },
        { userId: alice, online: false, away: false, version: 3 },
      ]);
      // She hears her own: the same changes Bob does, and, while online, whether the away is her
      // choice — which Bob never hears, so idle and chosen look the same to everybody else.
      expect(node.heard(alice)).toEqual([
        { userId: alice, online: true, away: false, version: 1, chosen: false },
        { userId: alice, online: true, away: true, version: 2, chosen: true },
        { userId: alice, online: false, away: false, version: 3 },
      ]);
      expect(node.heard(bob).some((change) => 'chosen' in change)).toBe(false);
    });
  });

  test('a workspace’s presence carries away for an idle member and for one who chose it (D-257)', async () => {
    await withRollback(async (db) => {
      const here = await aRoom(db, ['alice', 'bob', 'carol']);
      const alice = idOf(here, 'alice');
      const bob = idOf(here, 'bob');
      const carol = idOf(here, 'carol');
      await db
        .updateTable('users')
        .set({ away_chosen: true })
        .where('id', 'in', [alice, carol])
        .execute();
      const context = await requireWorkspaceMembership(db, bob, here.workspaceId);
      // Alice chose away and is not idle; Bob is idle and chose nothing; Carol chose away and is offline.
      const snapshot = await workspacePresence(db, context, {
        onlineAmong: (userIds) =>
          Promise.resolve(
            userIds.flatMap((userId) =>
              userId === carol ? [] : [{ userId, online: true, away: userId === bob, version: 5 }],
            ),
          ),
        version: () => 6,
      });
      expect(
        Object.fromEntries(snapshot.online.map((change) => [change.userId, change.away])),
      ).toEqual({ [alice]: true, [bob]: true });
    });
  });

  test('a choice made while the presence is read is paired with the version it was told at, never an older one (D-257)', async () => {
    await withRollback(async (db) => {
      const here = await aRoom(db, ['alice', 'bob']);
      const alice = idOf(here, 'alice');
      const context = await requireWorkspaceMembership(db, idOf(here, 'bob'), here.workspaceId);
      // Alice chooses away as the online record is read: her version 7 is the retelling's, which
      // carries the choice, so the snapshot must too — a client keeps the first it hears at a version.
      const snapshot = await workspacePresence(db, context, {
        onlineAmong: async (userIds) => {
          await db
            .updateTable('users')
            .set({ away_chosen: true })
            .where('id', '=', alice)
            .execute();
          return userIds.flatMap((userId) =>
            userId === alice ? [{ userId, online: true, away: false, version: 7 }] : [],
          );
        },
        version: () => 8,
      });
      expect(snapshot.online).toEqual([{ userId: alice, online: true, away: true, version: 7 }]);
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
              return at === undefined ? [] : [{ userId, online: true, away: false, version: at }];
            }),
          ),
        version: () => (version += 1),
      });
      // Carol is online, and in no workspace of Bob's: not in his.
      expect(snapshot).toEqual({
        online: [{ userId: alice, online: true, away: false, version: 3 }],
        version: 11,
      });
    });
  });
});
