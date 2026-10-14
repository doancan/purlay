/**
 * Who is responding to an incident, against the real database (#487, D-137 §3): members of its channel
 * brought in and taken off by anyone in it, idempotently, at most fifty; nobody outside the channel,
 * with one answer for every kind of outsider; kept after it is resolved and after they leave the
 * channel; every change on the timeline, naming who. The table holds the incident's channel itself.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Transaction } from '@purlay/db';
import { INCIDENT_RESPONDERS_MAX, messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { requireChannelById, type ChannelContext } from '../../platform/channels';
import { attempt } from '../../testing/attempt';
import { aRoom, type Room } from '../../testing/rooms';
import { changeIncident, declareIncident, incidentUpdates } from './incidents';
import { addResponder, removeResponder } from './responders';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);
let tick = 0;
const anId = (): string => messageId(new Date(NOW.getTime() - 60_000 + (tick += 1)));

const contextOf = (room: Room, name: string): ChannelContext => {
  const context = room.members[name]?.context;
  if (context === undefined) throw new Error(`no ${name}`);
  return context;
};
const idOf = (room: Room, name: string): string =>
  room.members[name]?.userId ?? room.outsiders[name]?.userId ?? '';

const declared = async (db: Transaction, context: ChannelContext): Promise<string> => {
  const id = anId();
  await declareIncident(db, clock, context, { id, severity: 2 });
  return id;
};

describe('integration: responders', () => {
  test('anyone in the channel brings in themselves or another, and takes them off; the same again is nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      const alice = contextOf(room, 'alice');
      const id = await declared(db, alice);
      const self = await addResponder(db, clock, alice, id, idOf(room, 'alice'));
      expect(self.changed).toBe(true);
      const other = await addResponder(db, clock, contextOf(room, 'carol'), id, idOf(room, 'bob'));
      expect(other.incident.responders.map((person) => person.id)).toEqual([
        idOf(room, 'alice'),
        idOf(room, 'bob'),
      ]);
      expect((await addResponder(db, clock, alice, id, idOf(room, 'bob'))).changed).toBe(false);
      const off = await removeResponder(db, clock, alice, id, idOf(room, 'bob'));
      expect([off.changed, off.incident.responders.map((person) => person.id)]).toEqual([
        true,
        [idOf(room, 'alice')],
      ]);
      expect((await removeResponder(db, clock, alice, id, idOf(room, 'bob'))).changed).toBe(false);

      const timeline = await incidentUpdates(db, alice, id, {});
      expect(
        timeline.data.map((entry) =>
          entry.change.kind === 'responder_added' || entry.change.kind === 'responder_removed'
            ? [entry.change.kind, entry.change.user?.username, entry.actor?.username]
            : [entry.change.kind],
        ),
      ).toEqual([
        ['responder_removed', room.members['bob']?.username, room.members['alice']?.username],
        ['responder_added', room.members['bob']?.username, room.members['carol']?.username],
        ['responder_added', room.members['alice']?.username, room.members['alice']?.username],
        ['declared'],
      ]);
    });
  });

  test('brought in at the same instant, they list in the order they were brought in', async () => {
    await withRollback(async (db) => {
      const names = ['p0', 'p1', 'p2', 'p3', 'p4'];
      const room = await aRoom(db, names);
      const first = contextOf(room, 'p0');
      const id = await declared(db, first);
      // The clock never moves: the order cannot come from it, nor from the ids.
      for (const name of [...names].reverse())
        await addResponder(db, clock, first, id, idOf(room, name));
      const shown = await removeResponder(db, clock, first, id, anId());
      expect(shown.incident.responders.map((person) => person.username)).toEqual(
        [...names].reverse().map((name) => room.members[name]?.username ?? ''),
      );
    });
  });

  test('nobody outside the channel responds, with one answer for every kind of outsider', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { outsiders: ['erin'] });
      const elsewhere = await aRoom(db, ['dave']);
      const alice = contextOf(room, 'alice');
      const id = await declared(db, alice);
      for (const userId of [idOf(room, 'erin'), idOf(elsewhere, 'dave'), anId(), 'not-an-id']) {
        expect(await attempt(db, () => addResponder(db, clock, alice, id, userId))).toBe(
          'USER_NOT_FOUND',
        );
      }
    });
  });

  test('a visible non-member changes nothing; another channel’s incident is not found', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { outsiders: ['erin'] });
      const other = await aRoom(db, ['alice']);
      const id = await declared(db, contextOf(room, 'alice'));
      const theirs = await declared(db, contextOf(other, 'alice'));
      const erin = await requireChannelById(db, idOf(room, 'erin'), room.channelId);
      expect(await attempt(db, () => addResponder(db, clock, erin, id, idOf(room, 'alice')))).toBe(
        'FORBIDDEN',
      );
      expect(
        await attempt(db, () =>
          addResponder(db, clock, contextOf(room, 'alice'), theirs, idOf(room, 'alice')),
        ),
      ).toBe('INCIDENT_NOT_FOUND');
    });
  });

  test('at most fifty: the fiftieth is taken, the fifty-first refused', async () => {
    await withRollback(async (db) => {
      const names = Array.from({ length: INCIDENT_RESPONDERS_MAX + 1 }, (_, n) => `r${String(n)}`);
      const room = await aRoom(db, names);
      const first = contextOf(room, 'r0');
      const id = await declared(db, first);
      for (const name of names.slice(0, INCIDENT_RESPONDERS_MAX - 1)) {
        await addResponder(db, clock, first, id, idOf(room, name));
      }
      const fiftieth = await addResponder(
        db,
        clock,
        first,
        id,
        idOf(room, names[INCIDENT_RESPONDERS_MAX - 1] ?? ''),
      );
      expect(fiftieth.incident.responders).toHaveLength(INCIDENT_RESPONDERS_MAX);
      expect(
        await attempt(db, () =>
          addResponder(db, clock, first, id, idOf(room, names[INCIDENT_RESPONDERS_MAX] ?? '')),
        ),
      ).toBe('INCIDENT_RESPONDERS_LIMIT');
    });
  });

  test('kept after it is resolved, and after they leave the channel: a record, not a presence', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = contextOf(room, 'alice');
      const id = await declared(db, alice);
      await addResponder(db, clock, alice, id, idOf(room, 'bob'));
      await changeIncident(db, clock, alice, id, { status: 'resolved' });
      // Who worked on it is still written up after.
      const after = await addResponder(db, clock, alice, id, idOf(room, 'alice'));
      expect(after.incident.responders).toHaveLength(2);
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', idOf(room, 'bob'))
        .execute();
      // Bob left: still on the list, and nothing changed under anybody without a word.
      const after2 = await removeResponder(db, clock, alice, id, idOf(room, 'alice'));
      expect(after2.incident.responders.map((person) => person.id)).toEqual([idOf(room, 'bob')]);
    });
  });

  test('the table refuses a responder for another channel’s incident', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const other = await aRoom(db, ['bob']);
      const id = await declared(db, contextOf(room, 'alice'));
      const insert = (channelId: string, userId: string): Promise<unknown> =>
        sql`insert into incident_responders (incident_id, channel_id, user_id, added_at)
            values (${id}, ${channelId}, ${userId}, ${NOW})`.execute(db);
      expect(await attempt(db, () => insert(other.channelId, idOf(other, 'bob')))).toContain(
        'incident_responders_incident_fkey',
      );
      expect(await attempt(db, () => insert(room.channelId, idOf(room, 'alice')))).toBe('taken');
    });
  });
});
