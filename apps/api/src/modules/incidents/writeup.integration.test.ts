/**
 * What is written down for an incident, against the real database (#487, D-137 §3, §5): its runbook,
 * an https link set, changed and cleared by anyone in the channel, the last change winning; its
 * postmortem, saved from the version it was edited from, a save from an older one refused rather than
 * written over. Both kept writable after it is resolved, both on the timeline without their words, and
 * both held by the table at its bound and one past it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Transaction } from '@purlay/db';
import { MESSAGE_CONTENT_MAX, RUNBOOK_URL_MAX, messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import type { ChannelContext } from '../../platform/channels';
import { attempt } from '../../testing/attempt';
import { aRoom, type Room } from '../../testing/rooms';
import { changeIncident, declareIncident, incidentUpdates, savePostmortem } from './incidents';

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

const declared = async (db: Transaction, context: ChannelContext): Promise<string> => {
  const id = anId();
  await declareIncident(db, clock, context, { id, severity: 2 });
  return id;
};

/** An https link exactly `length` characters long. */
const linkOf = (length: number): string => {
  const prefix = 'https://runbooks.example.test/';
  return prefix + 'a'.repeat(length - prefix.length);
};

describe('integration: an incident’s runbook', () => {
  test('set, changed and cleared, the last change winning, each on the timeline with its link', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = contextOf(room, 'alice');
      const id = await declared(db, alice);
      const set = await changeIncident(db, clock, alice, id, {
        runbookUrl: 'https://runbooks.example.test/db',
      });
      expect([set.changed, set.incident.runbookUrl]).toEqual([
        true,
        'https://runbooks.example.test/db',
      ]);
      const same = await changeIncident(db, clock, contextOf(room, 'bob'), id, {
        runbookUrl: 'https://runbooks.example.test/db',
      });
      expect(same.changed).toBe(false);
      const cleared = await changeIncident(db, clock, alice, id, { runbookUrl: null });
      expect(cleared.incident.runbookUrl).toBeNull();
      const timeline = await incidentUpdates(db, alice, id, {});
      expect(timeline.data.slice(0, 2).map((entry) => entry.change)).toEqual([
        { kind: 'runbook', url: null },
        { kind: 'runbook', url: 'https://runbooks.example.test/db' },
      ]);
    });
  });

  test('only an https link with a host, at most 2048 characters: at the bound and one past it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      const id = await declared(db, alice);
      for (const runbookUrl of [
        'http://example.test/',
        'javascript:alert(1)',
        'https://',
        // What PostgreSQL cannot store, and what would show one link and follow another.
        'https://example.test/a\u0000b',
        'https://example.test/\u202Eexe.txt',
        'https://example.test/\u200Bx',
        'https://example.test/\ud800',
        // Past the pattern, and no URL a browser could follow.
        'https://[',
      ]) {
        expect(await attempt(db, () => changeIncident(db, clock, alice, id, { runbookUrl }))).toBe(
          'VALIDATION_FAILED',
        );
      }
      const atBound = await changeIncident(db, clock, alice, id, {
        runbookUrl: linkOf(RUNBOOK_URL_MAX),
      });
      expect(atBound.incident.runbookUrl).toHaveLength(RUNBOOK_URL_MAX);
      // One past it: the table refuses what the contract would not have let through.
      expect(
        await attempt(db, () =>
          db
            .updateTable('incidents')
            .set({ runbook_url: linkOf(RUNBOOK_URL_MAX + 1) })
            .where('id', '=', id)
            .execute(),
        ),
      ).toContain('incidents_runbook_url');
      expect(
        await attempt(db, () =>
          db
            .updateTable('incidents')
            .set({ runbook_url: 'http://example.test/' })
            .where('id', '=', id)
            .execute(),
        ),
      ).toContain('incidents_runbook_url');
    });
  });

  test('after it is resolved its runbook may change; its status still may not, even beside it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      const id = await declared(db, alice);
      await changeIncident(db, clock, alice, id, { status: 'resolved' });
      // Later: the resolution keeps its instant, not the runbook's.
      const after = await changeIncident(
        db,
        fixedClock(new Date(NOW.getTime() + 60_000)),
        alice,
        id,
        {
          runbookUrl: 'https://runbooks.example.test/after',
        },
      );
      expect([after.incident.status, after.incident.runbookUrl]).toEqual([
        'resolved',
        'https://runbooks.example.test/after',
      ]);
      expect(after.incident.resolvedAt).toBe(NOW.toISOString());
      expect(
        await attempt(db, () =>
          changeIncident(db, clock, alice, id, {
            status: 'mitigating',
            runbookUrl: 'https://runbooks.example.test/other',
          }),
        ),
      ).toBe('INCIDENT_RESOLVED');
    });
  });
});

describe('integration: an incident’s postmortem', () => {
  test('saved from its version, which rises; the same words again change nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = contextOf(room, 'alice');
      const id = await declared(db, alice);
      const first = await savePostmortem(db, clock, alice, id, { content: '# What', version: 0 });
      expect([first.changed, first.incident.postmortem, first.incident.postmortemVersion]).toEqual([
        true,
        '# What',
        1,
      ]);
      const again = await savePostmortem(db, clock, contextOf(room, 'bob'), id, {
        content: '# What',
        version: 1,
      });
      expect([again.changed, again.incident.postmortemVersion]).toEqual([false, 1]);
      const timeline = await incidentUpdates(db, alice, id, {});
      // The fact of it, never its words.
      expect(timeline.data[0]?.change).toEqual({ kind: 'postmortem', version: 1 });
      expect(JSON.stringify(timeline)).not.toContain('# What');
    });
  });

  test('a retry of a save that landed is answered as done, not as somebody else’s save', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      const id = await declared(db, alice);
      await savePostmortem(db, clock, alice, id, { content: 'what happened', version: 0 });
      // The answer was lost; the client sends the same save, from the same version, again.
      const retried = await savePostmortem(db, clock, alice, id, {
        content: 'what happened',
        version: 0,
      });
      expect([retried.changed, retried.incident.postmortemVersion]).toEqual([false, 1]);
    });
  });

  test('a save from a version another save replaced is refused, and nothing is written over', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = contextOf(room, 'alice');
      const id = await declared(db, alice);
      await savePostmortem(db, clock, alice, id, { content: 'alice’s', version: 0 });
      expect(
        await attempt(db, () =>
          savePostmortem(db, clock, contextOf(room, 'bob'), id, { content: 'bob’s', version: 0 }),
        ),
      ).toBe('INCIDENT_POSTMORTEM_CHANGED');
      const kept = await savePostmortem(db, clock, alice, id, { content: 'alice’s', version: 1 });
      expect(kept.incident.postmortem).toBe('alice’s');
    });
  });

  test('written after it is resolved, by members only; another channel’s is not found', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { outsiders: ['erin'] });
      const other = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      const id = await declared(db, alice);
      const theirs = await declared(db, contextOf(other, 'alice'));
      await changeIncident(db, clock, alice, id, { status: 'resolved' });
      expect(
        (await savePostmortem(db, clock, alice, id, { content: 'after', version: 0 })).changed,
      ).toBe(true);
      expect(
        await attempt(db, () =>
          savePostmortem(db, clock, alice, theirs, { content: 'x', version: 0 }),
        ),
      ).toBe('INCIDENT_NOT_FOUND');
    });
  });

  test('the table holds it to a message’s bound, counting what lies outside the BMP twice', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      const id = await declared(db, alice);
      const write = (postmortem: string): Promise<unknown> =>
        sql`update incidents set postmortem = ${postmortem} where id = ${id}`.execute(db);
      // At the bound in UTF-16 units: one astral character is two.
      expect(await attempt(db, () => write('a'.repeat(MESSAGE_CONTENT_MAX - 2) + '😀'))).toBe(
        'taken',
      );
      expect(await attempt(db, () => write('a'.repeat(MESSAGE_CONTENT_MAX - 1) + '😀'))).toContain(
        'incidents_postmortem_length',
      );
    });
  });
});
