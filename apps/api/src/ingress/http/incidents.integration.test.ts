/**
 * A channel's incident through HTTP (#487, D-137): the routes' answers and statuses, and who is told
 * — the channel, after the commit, once for each change, and never for one that was none or refused.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import {
  MESSAGE_CONTENT_MAX,
  RUNBOOK_URL_MAX,
  messageId,
  type Incident,
  type IncidentResponse,
  type IncidentUpdatePage,
  type ServerFrame,
} from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { channelTopic, NO_LOG, type EventBus } from '../../platform/events';
import { SESSION_COOKIE } from '../../platform/cookies';
import { aTestAuth, aSession } from '../../testing/signed-in';
import { aRoom } from '../../testing/rooms';
import { testDependencies } from '../../testing/doubles';
import { createApp } from './app';
import { patchIncident, postIncident, putPostmortem, putResponder } from './incidents';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;

const recordingBus = (): { readonly bus: EventBus; readonly told: [string, ServerFrame][] } => {
  const told: [string, ServerFrame][] = [];
  return {
    told,
    bus: {
      publish: (topic, frame): Promise<void> => {
        told.push([topic, frame]);
        return Promise.resolve();
      },
      subscribe: () => false,
      unsubscribe: () => undefined,
      forget: () => undefined,
    },
  };
};

const caller = async (db: Executor, userId: string): Promise<Call> => {
  const { token } = await aSession(db, clock, userId, 30);
  const app = createApp(testDependencies({ database: db, clock }));
  return async (method, path, body) =>
    await app.handle(
      new Request(`https://purlay.test${path}`, {
        method,
        headers: {
          cookie: `${SESSION_COOKIE}=${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
};

const codeOf = async (response: Response): Promise<[number, unknown]> => [
  response.status,
  ((await response.json()) as { error?: { code?: unknown } }).error?.code,
];

describe('integration: the incident routes', () => {
  test('declared 201, the same again 200, read by anyone who can see it, moved, its timeline', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { outsiders: ['erin'] });
      const alice = await caller(db, room.members['alice']?.userId ?? '');
      const erin = await caller(db, room.outsiders['erin']?.userId ?? '');
      const base = `/api/channels/${room.channelId}/incident`;

      const none = await alice('GET', base);
      expect([none.status, await none.json()]).toEqual([200, { incident: null }]);

      const id = messageId(NOW);
      const made = await alice('POST', base, { id, severity: 2 });
      expect(made.status).toBe(201);
      expect(((await made.json()) as Incident).status).toBe('investigating');
      const again = await alice('POST', base, { id, severity: 2 });
      expect(again.status).toBe(200);

      // A visible non-member reads it, and is refused a change.
      expect(((await (await erin('GET', base)).json()) as IncidentResponse).incident?.id).toBe(id);
      expect(await codeOf(await erin('PATCH', `${base}/${id}`, { status: 'mitigating' }))).toEqual([
        403,
        'NOT_A_CHANNEL_MEMBER',
      ]);

      const moved = await alice('PATCH', `${base}/${id}`, { status: 'mitigating' });
      expect(((await moved.json()) as Incident).status).toBe('mitigating');
      // The same again changes nothing.
      expect((await alice('PATCH', `${base}/${id}`, { status: 'mitigating' })).status).toBe(200);

      const timeline = (await (
        await alice('GET', `${base}/${id}/updates?limit=10`)
      ).json()) as IncidentUpdatePage;
      expect(timeline.data.map((entry) => entry.change.kind)).toEqual(['status', 'declared']);
    });
  });

  test('what the contract refuses is refused before anything is written', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = await caller(db, room.members['alice']?.userId ?? '');
      const base = `/api/channels/${room.channelId}/incident`;
      for (const body of [
        { id: messageId(NOW), severity: 5 },
        { id: messageId(NOW), severity: 0 },
        { id: 'not-an-id', severity: 1 },
        { id: messageId(NOW), severity: 1, status: 'resolved' },
      ]) {
        expect(await codeOf(await alice('POST', base, body))).toEqual([400, 'VALIDATION_FAILED']);
      }
      const id = messageId(NOW);
      await alice('POST', base, { id, severity: 1 });
      for (const body of [
        {},
        { status: 'closed' },
        { severity: 1, extra: true },
        { runbookUrl: 'http://example.test/' },
        { runbookUrl: 'https://example.test/a\u0000b' },
        { runbookUrl: `https://example.test/${'a'.repeat(RUNBOOK_URL_MAX)}` },
      ]) {
        expect(await codeOf(await alice('PATCH', `${base}/${id}`, body))).toEqual([
          400,
          'VALIDATION_FAILED',
        ]);
      }
      expect(
        await codeOf(await alice('PATCH', `${base}/${messageId(NOW)}`, { severity: 2 })),
      ).toEqual([404, 'INCIDENT_NOT_FOUND']);
      for (const body of [
        { content: 'x', version: -1 },
        { content: 'x' },
        { content: 'a'.repeat(MESSAGE_CONTENT_MAX + 1), version: 0 },
      ]) {
        expect(await codeOf(await alice('PUT', `${base}/${id}/postmortem`, body))).toEqual([
          400,
          'VALIDATION_FAILED',
        ]);
      }
      // Nothing written by any of them: the declaration alone is on its timeline.
      const timeline = (await (
        await alice('GET', `${base}/${id}/updates`)
      ).json()) as IncidentUpdatePage;
      expect(timeline.data.map((entry) => entry.change.kind)).toEqual(['declared']);
    });
  });
});

describe('integration: a responder, on the person axis', () => {
  test('somebody from another workspace, in the caller’s own channel, is not found — like nobody', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const elsewhere = await aRoom(db, ['dave']);
      const alice = await caller(db, room.members['alice']?.userId ?? '');
      const base = `/api/channels/${room.channelId}/incident`;
      const id = messageId(NOW);
      expect((await alice('POST', base, { id, severity: 2 })).status).toBe(201);
      const responders = `${base}/${id}/responders`;
      const stranger = await alice(
        'PUT',
        `${responders}/${elsewhere.members['dave']?.userId ?? ''}`,
      );
      const nobody = await alice('PUT', `${responders}/${messageId(new Date(NOW.getTime() + 1))}`);
      expect([await codeOf(stranger), await codeOf(nobody)]).toEqual([
        [404, 'USER_NOT_FOUND'],
        [404, 'USER_NOT_FOUND'],
      ]);
      // Taking off somebody who is not responding is the same answer as for anyone: unchanged.
      const off = await alice('DELETE', `${responders}/${elsewhere.members['dave']?.userId ?? ''}`);
      expect([off.status, ((await off.json()) as Incident).responders]).toEqual([200, []]);
    });
  });
});

describe('integration: who is told of an incident', () => {
  test('the channel, after the commit, once for each change — responders too; never a repeat, a no-op or a refusal', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { outsiders: ['erin'] });
      const { bus, told } = recordingBus();
      const dependencies = { auth: aTestAuth(db), database: db, clock, bus, log: NO_LOG };
      const asked = async (userId: string): Promise<() => Request> => {
        const { token } = await aSession(db, clock, userId, 30);
        return () =>
          new Request('https://purlay.test/', {
            headers: { cookie: `${SESSION_COOKIE}=${token}` },
          });
      };
      const alice = await asked(room.members['alice']?.userId ?? '');
      const erin = await asked(room.outsiders['erin']?.userId ?? '');
      const id = messageId(NOW);

      await postIncident(dependencies, alice(), room.channelId, { id, severity: 2 });
      await postIncident(dependencies, alice(), room.channelId, { id, severity: 2 });
      const refused = await patchIncident(dependencies, erin(), room.channelId, id, {
        status: 'mitigating',
      }).then(
        () => 'taken',
        (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
      );
      await patchIncident(dependencies, alice(), room.channelId, id, { status: 'mitigating' });
      await patchIncident(dependencies, alice(), room.channelId, id, { status: 'mitigating' });
      // A responder brought in and taken off: once each; again, nothing.
      const aliceId = room.members['alice']?.userId ?? '';
      const brought = await putResponder(dependencies, alice(), room.channelId, id, aliceId, true);
      expect(brought.responders.map((person) => person.id)).toEqual([aliceId]);
      await putResponder(dependencies, alice(), room.channelId, id, aliceId, true);
      await putResponder(dependencies, alice(), room.channelId, id, aliceId, false);
      await putResponder(dependencies, alice(), room.channelId, id, aliceId, false);
      // The postmortem saved, and the same words again: once.
      const saved = await putPostmortem(dependencies, alice(), room.channelId, id, {
        content: 'what happened',
        version: 0,
      });
      expect(saved.postmortemVersion).toBe(1);
      await putPostmortem(dependencies, alice(), room.channelId, id, {
        content: 'what happened',
        version: 1,
      });

      expect(refused).toBe('NOT_A_CHANNEL_MEMBER');
      const frame: ServerFrame = {
        event: 'INCIDENT_UPDATED',
        data: { channelId: room.channelId },
        ts: NOW.getTime(),
      };
      expect(told).toEqual([
        [channelTopic(room.channelId), frame],
        [channelTopic(room.channelId), frame],
        [channelTopic(room.channelId), frame],
        [channelTopic(room.channelId), frame],
        [channelTopic(room.channelId), frame],
      ]);
    });
  });
});
