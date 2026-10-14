/**
 * A channel's incidents against the real database (#487, D-137): declared by anyone in the channel,
 * idempotent on its id and conflicting on any other use of it, one open at a time; moved, made worse
 * or better, resolved once; every change on its timeline, in order; the channel's list carrying the
 * open one's mark. The tables hold what the service says, at the bound and one past it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Transaction } from '@purlay/db';
import { messageId, type IncidentSeverity } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { requireChannelById, type ChannelContext } from '../../platform/channels';
import { attempt } from '../../testing/attempt';
import { aRoom, type Room } from '../../testing/rooms';
import { channelFor } from '../channels/channels';
import { changeIncident, channelIncident, declareIncident, incidentUpdates } from './incidents';

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

const declared = async (
  db: Transaction,
  context: ChannelContext,
  severity: IncidentSeverity = 2,
  id = anId(),
): Promise<string> => {
  await declareIncident(db, clock, context, { id, severity });
  return id;
};

describe('integration: declaring an incident', () => {
  test('anyone in the channel declares it, investigating, with the declaration on its timeline', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const id = anId();
      const { incident, changed } = await declareIncident(db, clock, contextOf(room, 'bob'), {
        id,
        severity: 1,
      });
      expect(changed).toBe(true);
      expect(incident).toMatchObject({
        id,
        channelId: room.channelId,
        severity: 1,
        status: 'investigating',
        declaredAt: NOW.toISOString(),
        resolvedAt: null,
      });
      expect(incident.declaredBy?.id).toBe(room.members['bob']?.userId);
      const timeline = await incidentUpdates(db, contextOf(room, 'alice'), id, {});
      expect(timeline.data.map((entry) => entry.change)).toEqual([
        { kind: 'declared', severity: 1 },
      ]);
      expect(await channelIncident(db, contextOf(room, 'alice'))).toEqual(incident);
    });
  });

  test('the same declaration again is the incident it made, and tells nobody', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const id = await declared(db, contextOf(room, 'alice'), 3);
      const again = await declareIncident(db, clock, contextOf(room, 'bob'), { id, severity: 3 });
      expect(again.changed).toBe(false);
      expect(again.incident.id).toBe(id);
      // Recorded once.
      expect((await incidentUpdates(db, contextOf(room, 'alice'), id, {})).data).toHaveLength(1);
    });
  });

  test('a retry that comes late — after it moved, after another was declared — is still the incident it made', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = contextOf(room, 'alice');
      const id = await declared(db, alice, 2);
      // Made worse by somebody else, then resolved, then another declared, before the retry lands.
      await changeIncident(db, clock, contextOf(room, 'bob'), id, { severity: 1 });
      await changeIncident(db, clock, alice, id, { status: 'resolved' });
      const other = await declared(db, alice, 3);
      const retried = await declareIncident(db, clock, alice, { id, severity: 2 });
      expect(retried.changed).toBe(false);
      expect(retried.incident).toMatchObject({ id, severity: 1, status: 'resolved' });
      // And the one open now is untouched.
      expect((await channelIncident(db, alice))?.id).toBe(other);
    });
  });

  test('its id used any other way is a conflict that names nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const elsewhere = await aRoom(db, ['carol']);
      const id = await declared(db, contextOf(room, 'alice'), 2);
      // Another severity here; another channel, in another workspace.
      expect(
        await attempt(db, () =>
          declareIncident(db, clock, contextOf(room, 'alice'), { id, severity: 1 }),
        ),
      ).toBe('INCIDENT_ID_CONFLICT');
      expect(
        await attempt(db, () =>
          declareIncident(db, clock, contextOf(elsewhere, 'carol'), { id, severity: 2 }),
        ),
      ).toBe('INCIDENT_ID_CONFLICT');
    });
  });

  test('one open at a time; resolved, another may be declared, and is the one shown', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      const first = await declared(db, alice);
      expect(await attempt(db, () => declared(db, alice))).toBe('INCIDENT_OPEN');
      await changeIncident(db, clock, alice, first, { status: 'resolved' });
      expect((await channelIncident(db, alice))?.id).toBe(first);
      const second = await declared(db, alice, 4);
      expect((await channelIncident(db, alice))?.id).toBe(second);
    });
  });

  test('a visible non-member is refused, a direct message has none, and an id must be a UUIDv7', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { outsiders: ['erin'] });
      const erinId = room.outsiders['erin']?.userId ?? '';
      const erin = await requireChannelById(db, erinId, room.channelId);
      expect(await attempt(db, () => declared(db, erin))).toBe('FORBIDDEN');
      // She can read it, though: seeing a public channel is seeing its incident.
      expect(await channelIncident(db, erin)).toBeNull();

      const direct = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
      expect(await attempt(db, () => declared(db, contextOf(direct, 'alice')))).toBe(
        'CHANNEL_NOT_FOUND',
      );
      expect(await channelIncident(db, contextOf(direct, 'alice'))).toBeNull();

      const notV7 = '0199155c-6200-4b7f-8c11-000000000001';
      expect(await attempt(db, () => declared(db, contextOf(room, 'alice'), 2, notV7))).toBe(
        'VALIDATION_FAILED',
      );
    });
  });
});

describe('integration: changing an incident', () => {
  test('status and severity move, each change on the timeline in the order made; the same again is nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = contextOf(room, 'alice');
      const id = await declared(db, alice, 3);
      const moved = await changeIncident(db, clock, contextOf(room, 'bob'), id, {
        status: 'mitigating',
        severity: 1,
      });
      expect(moved.changed).toBe(true);
      expect(moved.incident).toMatchObject({ status: 'mitigating', severity: 1 });
      const same = await changeIncident(db, clock, alice, id, { status: 'mitigating' });
      expect(same.changed).toBe(false);
      await changeIncident(db, clock, alice, id, { status: 'investigating' });
      const timeline = await incidentUpdates(db, alice, id, {});
      expect(timeline.data.map((entry) => entry.change)).toEqual([
        { kind: 'status', from: 'mitigating', to: 'investigating' },
        { kind: 'severity', from: 3, to: 1 },
        { kind: 'status', from: 'investigating', to: 'mitigating' },
        { kind: 'declared', severity: 3 },
      ]);
      expect(timeline.data[1]?.actor?.id).toBe(room.members['bob']?.userId);
    });
  });

  test('resolved is once: it has its instant, and nothing changes it after', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      const id = await declared(db, alice);
      const resolved = await changeIncident(
        db,
        fixedClock(new Date(NOW.getTime() + 5_000)),
        alice,
        id,
        {
          status: 'resolved',
        },
      );
      expect(resolved.incident.resolvedAt).toBe(new Date(NOW.getTime() + 5_000).toISOString());
      expect(await attempt(db, () => changeIncident(db, clock, alice, id, { severity: 1 }))).toBe(
        'INCIDENT_RESOLVED',
      );
      expect(
        await attempt(db, () => changeIncident(db, clock, alice, id, { status: 'mitigating' })),
      ).toBe('INCIDENT_RESOLVED');
      // Asking for what it already is still answers it.
      expect((await changeIncident(db, clock, alice, id, { status: 'resolved' })).changed).toBe(
        false,
      );
    });
  });

  test('another channel’s incident, an unknown id, or not an id at all is not found', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const other = await aRoom(db, ['alice']);
      const theirs = await declared(db, contextOf(other, 'alice'));
      const alice = contextOf(room, 'alice');
      for (const id of [theirs, anId(), 'not-an-id']) {
        expect(
          await attempt(db, () => changeIncident(db, clock, alice, id, { status: 'mitigating' })),
        ).toBe('INCIDENT_NOT_FOUND');
        expect(await attempt(db, () => incidentUpdates(db, alice, id, {}))).toBe(
          'INCIDENT_NOT_FOUND',
        );
      }
    });
  });

  test('a visible non-member cannot change it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { outsiders: ['erin'] });
      const id = await declared(db, contextOf(room, 'alice'));
      const erin = await requireChannelById(
        db,
        room.outsiders['erin']?.userId ?? '',
        room.channelId,
      );
      expect(
        await attempt(db, () => changeIncident(db, clock, erin, id, { status: 'mitigating' })),
      ).toBe('FORBIDDEN');
    });
  });
});

describe('integration: an incident’s timeline and its mark', () => {
  test('pages newest first, exactly at the limit and past it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      const id = await declared(db, alice, 4);
      // Three more entries: four in all.
      for (const severity of [3, 2, 1] as const) {
        await changeIncident(db, clock, alice, id, { severity });
      }
      const exact = await incidentUpdates(db, alice, id, { limit: 4 });
      expect(exact.data).toHaveLength(4);
      expect(exact.nextCursor).toBeNull();
      const first = await incidentUpdates(db, alice, id, { limit: 3 });
      expect(first.data).toHaveLength(3);
      const rest = await incidentUpdates(db, alice, id, {
        limit: 3,
        ...(first.nextCursor === null ? {} : { before: first.nextCursor }),
      });
      expect(rest.data.map((entry) => entry.change)).toEqual([{ kind: 'declared', severity: 4 }]);
      expect(rest.nextCursor).toBeNull();
    });
  });

  test('the channel list carries the open incident’s mark, and none once it is resolved', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      // The list's own read, as the sidebar gets it: one channel, as the caller sees it.
      const mark = async (): Promise<unknown> =>
        (await channelFor(db, alice.userId, room.channelId)).incident;
      expect(await mark()).toBeNull();
      const id = await declared(db, alice, 2);
      expect(await mark()).toEqual({ severity: 2, status: 'investigating' });
      await changeIncident(db, clock, alice, id, { status: 'resolved' });
      expect(await mark()).toBeNull();
    });
  });

  test('the tables refuse what the service never writes', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const row = (over: Record<string, unknown>): Record<string, unknown> => ({
        id: anId(),
        channel_id: room.channelId,
        workspace_id: room.workspaceId,
        severity: 2,
        declared_at: NOW,
        ...over,
      });
      const insert = (over: Record<string, unknown>): Promise<unknown> =>
        sql`insert into incidents ${sql.raw('(id, channel_id, workspace_id, severity, declared_at, status, resolved_at)')}
            values (${row(over)['id']}, ${room.channelId}, ${room.workspaceId}, ${row(over)['severity']},
                    ${NOW}, ${row(over)['status'] ?? 'investigating'}, ${row(over)['resolved_at'] ?? null})`.execute(
          db,
        );
      expect(await attempt(db, () => insert({ severity: 0 }))).toContain(
        'incidents_severity_known',
      );
      expect(await attempt(db, () => insert({ severity: 5 }))).toContain(
        'incidents_severity_known',
      );
      expect(await attempt(db, () => insert({ status: 'resolved' }))).toContain(
        'incidents_resolved_at',
      );
      expect(await attempt(db, () => insert({ resolved_at: NOW }))).toContain(
        'incidents_resolved_at',
      );
      expect(
        await attempt(db, () => insert({ id: '0199155c-6200-4b7f-8c11-000000000002' })),
      ).toContain('incidents_id_is_uuidv7');
      // Two open in one channel: the index, whatever the service checked.
      expect(await attempt(db, () => insert({}))).toBe('taken');
      expect(await attempt(db, () => insert({}))).toContain('idx_incidents_one_open');
      // At the bounds, taken: SEV4 resolved with its instant.
      expect(
        await attempt(db, () => insert({ severity: 4, status: 'resolved', resolved_at: NOW })),
      ).toBe('taken');
    });
  });
});
