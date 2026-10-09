/**
 * The attack, end to end: a NUL in a name was a 500 INTERNAL and an error report.
 * It is the caller's mistake, so it is a 400 that names the field and echoes nothing.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { createApp } from './app';
import { aSignedInUser } from '../../testing/signed-in';
import { NOW, aRecordingLogger, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);

describe('integration: a name with a control character', () => {
  test('is VALIDATION_FAILED on a workspace and on a channel, never INTERNAL', async () => {
    await withRollback(async (db) => {
      const recorded = aRecordingLogger();
      const app = createApp(testDependencies({ database: db, clock, log: recorded.log }));
      const user = await aSignedInUser(db, clock, 'nm');
      const post = async (path: string, body: string): Promise<Response> =>
        await app.handle(
          new Request(`https://purlay.test${path}`, {
            method: 'POST',
            headers: { cookie: user.cookie, 'content-type': 'application/json' },
            body,
          }),
        );

      const slug = aUniqueSlug('nm');
      for (const name of ['a\\u0000b', 'a\\u202Eb', 'a\\ud800b']) {
        const workspace = await post('/api/workspaces', `{"name":"${name}","slug":"${slug}"}`);
        expect({ name, status: workspace.status }).toEqual({ name, status: 400 });
        const body = (await workspace.json()) as {
          error: { code: string; details: { fields: Record<string, string> } };
        };
        expect(body.error.code).toBe('VALIDATION_FAILED');
        expect(Object.keys(body.error.details.fields)).toEqual(['name']);
      }

      const created = await post('/api/workspaces', `{"name":"ok","slug":"${slug}"}`);
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      for (const name of ['a\\u0000b', 'a\\u202Eb']) {
        const channel = await post(`/api/workspaces/${id}/channels`, `{"name":"${name}"}`);
        expect({ name, status: channel.status }).toEqual({ name, status: 400 });
      }
      const topic = await post(
        `/api/workspaces/${id}/channels`,
        '{"name":"x","topic":"a\\u0000b"}',
      );
      expect(topic.status).toBe(400);

      // Nothing here was a failure of ours, so nothing was reported as one.
      expect(recorded.lines.filter((line) => line['level'] === 'error')).toEqual([]);
    });
  });
});
