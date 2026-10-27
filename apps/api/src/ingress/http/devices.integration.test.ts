/**
 * `GET /api/me/sessions` and `DELETE /api/me/sessions/:sessionId` (D-193), against a real database: where a
 * person is signed in, and the means to end one place without ending the rest. What is checked is what
 * could go wrong for somebody else — another person's session listed or ended, an answer that tells a
 * stranger's id from an unknown one, a token digest or an address in the answer — and that ending a session
 * ends it.
 */
import { describe, expect, test } from 'bun:test';
import { withRollback, type Executor } from '@purlay/db';
import { DEVICE_SESSIONS_MAX, DeviceSessionList } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import { createApp } from './app';
import { fixedClock } from '../../platform/clock';
import { NOW, testDependencies } from '../../testing/doubles';
import { aSession, aSignedInUser } from '../../testing/signed-in';
import { SESSION_COOKIE } from '../../platform/cookies';

const ORIGIN = 'https://purlay.test';
const clock = fixedClock(NOW);

const call = async (
  db: Executor,
  method: 'GET' | 'DELETE',
  path: string,
  cookie?: string,
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock })).handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        ...(method === 'GET' ? {} : { origin: ORIGIN }),
      },
    }),
  );

const listed = async (db: Executor, cookie: string): Promise<DeviceSessionList> => {
  const response = await call(db, 'GET', '/api/me/sessions', cookie);
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(Value.Check(DeviceSessionList, body)).toBe(true);
  return body as DeviceSessionList;
};

const cookieOf = (token: string): string => `${SESSION_COOKIE}=${token}`;

describe('integration: where the caller is signed in', () => {
  test('names each live session, the current one as such, and a native one by its device', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, clock, 'devices-ada');
      const mac = await aSession(db, clock, ada.userId, 30, {
        userAgent: 'Purlay for macOS/1.0.0 (Ada’s MacBook)',
        deviceName: 'Ada’s MacBook',
      });
      const { data } = await listed(db, ada.cookie);
      const places = data.map(({ id, kind, name, current }) => ({ id, kind, name, current }));
      expect(places).toContainEqual({
        id: ada.sessionId,
        kind: 'browser',
        name: null,
        current: true,
      });
      expect(places).toContainEqual({
        id: mac.sessionId,
        kind: 'native',
        name: 'Ada’s MacBook',
        current: false,
      });
      expect(data).toHaveLength(2);
    });
  });

  test('is newest use first, and holds back nothing that could end a session or find a person', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, clock, 'devices-order');
      const older = await aSession(db, clock, ada.userId, 30, {
        userAgent: 'Mozilla/5.0 (a very identifying agent)',
        ipAddress: '203.0.113.9',
      });
      await db
        .updateTable('sessions')
        .set({ last_used_at: new Date(NOW.getTime() - 3 * 3_600_000) })
        .where('id', '=', older.sessionId)
        .execute();
      const response = await call(db, 'GET', '/api/me/sessions', ada.cookie);
      const text = await response.text();
      const { data } = JSON.parse(text) as DeviceSessionList;
      expect(data.map((row) => row.id)).toEqual([ada.sessionId, older.sessionId]);
      for (const forbidden of ['203.0.113.9', 'identifying agent', 'token', 'ip', 'agent']) {
        expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    });
  });

  test('never lists a session that has lapsed, nor anybody else’s', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, clock, 'devices-mine');
      const bob = await aSignedInUser(db, clock, 'devices-theirs');
      const lapsed = await aSession(db, clock, ada.userId);
      await db
        .updateTable('sessions')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('id', '=', lapsed.sessionId)
        .execute();
      const { data } = await listed(db, ada.cookie);
      expect(data.map((row) => row.id)).toEqual([ada.sessionId]);
      expect((await listed(db, bob.cookie)).data.map((row) => row.id)).toEqual([bob.sessionId]);
    });
  });

  test('names at most DEVICE_SESSIONS_MAX, the current one always among them and first, then those used last', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, clock, 'devices-many');
      await db
        .insertInto('sessions')
        .values(
          Array.from({ length: DEVICE_SESSIONS_MAX + 5 }, (_, n) => ({
            user_id: ada.userId,
            token_hash: `${'a'.repeat(60)}${String(n).padStart(4, '0')}`,
            last_used_at: new Date(NOW.getTime() - (n + 1) * 60_000),
            expires_at: new Date(Date.now() + 86_400_000),
          })),
        )
        .execute();
      // Asking resolves the caller's session, which refreshes it (D-60): it is the newest used, and so first. Asserted
      // so that nothing can drop a person's own session from their own list.
      await db
        .updateTable('sessions')
        .set({ last_used_at: new Date(NOW.getTime() - 365 * 86_400_000) })
        .where('id', '=', ada.sessionId)
        .execute();
      const { data } = await listed(db, ada.cookie);
      expect(data).toHaveLength(DEVICE_SESSIONS_MAX);
      expect(data[0]).toMatchObject({ id: ada.sessionId, current: true });
      expect(data.filter((row) => row.current)).toHaveLength(1);
    });
  });

  test('says no to a caller with no session', async () => {
    await withRollback(async (db) => {
      expect((await call(db, 'GET', '/api/me/sessions')).status).toBe(401);
      expect((await call(db, 'DELETE', `/api/me/sessions/${crypto.randomUUID()}`)).status).toBe(
        401,
      );
    });
  });
});

describe('integration: what a session may be named', () => {
  test.each(['', 'x'.repeat(65)])('a name of %p is not kept', async (name) => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, clock, 'devices-names');
      let refusal: unknown;
      try {
        await aSession(db, clock, ada.userId, 30, { deviceName: name });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(Error);
    });
  });

  test('a name of the longest length is', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, clock, 'devices-longest');
      await aSession(db, clock, ada.userId, 30, { deviceName: 'x'.repeat(64) });
    });
  });
});

describe('integration: ending one of them', () => {
  test('ends that session and no other, and the one ended stops resolving', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, clock, 'devices-end');
      const mac = await aSession(db, clock, ada.userId, 30, { deviceName: 'Mac' });
      const response = await call(db, 'DELETE', `/api/me/sessions/${mac.sessionId}`, ada.cookie);
      expect(response.status).toBe(204);
      expect((await listed(db, ada.cookie)).data.map((row) => row.id)).toEqual([ada.sessionId]);
      expect((await call(db, 'GET', '/api/me', cookieOf(mac.token))).status).toBe(401);
      expect((await call(db, 'GET', '/api/me', ada.cookie)).status).toBe(200);
    });
  });

  test('another person’s session, an unknown one and one already ended are the same answer, and nothing is ended', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, clock, 'devices-stranger-a');
      const bob = await aSignedInUser(db, clock, 'devices-stranger-b');
      const gone = await aSession(db, clock, ada.userId);
      expect(
        (await call(db, 'DELETE', `/api/me/sessions/${gone.sessionId}`, ada.cookie)).status,
      ).toBe(204);
      const answers: string[] = [];
      for (const id of [bob.sessionId, crypto.randomUUID(), gone.sessionId]) {
        const response = await call(db, 'DELETE', `/api/me/sessions/${id}`, ada.cookie);
        expect(response.status).toBe(404);
        answers.push(JSON.stringify(await response.json()));
      }
      expect(new Set(answers).size).toBe(1);
      expect(answers[0]).toContain('SESSION_NOT_FOUND');
      expect((await call(db, 'GET', '/api/me', bob.cookie)).status).toBe(200);
    });
  });

  test('a session id that is not one is refused as malformed, not as missing', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, clock, 'devices-malformed');
      const response = await call(db, 'DELETE', '/api/me/sessions/not-an-id', ada.cookie);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    });
  });

  test('ending the session the request came in on is signing out of it', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, clock, 'devices-self');
      const other = await aSession(db, clock, ada.userId);
      const response = await call(db, 'DELETE', `/api/me/sessions/${ada.sessionId}`, ada.cookie);
      expect(response.status).toBe(204);
      expect((await call(db, 'GET', '/api/me', ada.cookie)).status).toBe(401);
      expect((await call(db, 'GET', '/api/me', cookieOf(other.token))).status).toBe(200);
    });
  });
});
