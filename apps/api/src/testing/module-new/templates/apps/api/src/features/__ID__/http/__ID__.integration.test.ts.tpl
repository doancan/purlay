/**
 * __PASCAL__ over HTTP, on a real database: who may list and create, and what a stranger and another workspace see (nothing).
 *
 * @needs-modules __ID__
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { __UPPER___TITLE_MAX, type __PASCAL__Item } from '@purlay/types';
import { composition } from '../../../composition';
import { fixedClock } from '../../../platform/clock';
import { NOW, testDependencies } from '../../../testing/doubles';
import { aSignedInUser } from '../../../testing/signed-in';
import { aUniqueSlug } from '../../../testing/users';
import { createApp } from '../../../ingress/http/app';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ORIGIN = 'https://purlay.test';

describe('integration: __ID__ over HTTP', () => {
  test('a member creates a row and lists it; a stranger is told the workspace is not there; a bad title is refused', async () => {
    await withRollback(async (db) => {
      const clock = fixedClock(NOW);
      const app = createApp(testDependencies({ database: db, clock, composition }));
      const member = await aSignedInUser(db, clock, 'member');
      const stranger = await aSignedInUser(db, clock, 'stranger');
      const call = async (
        method: string,
        path: string,
        cookie: string,
        body?: unknown,
      ): Promise<{ status: number; body: unknown }> => {
        const response = await app.handle(
          new Request(`${ORIGIN}${path}`, {
            method,
            headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        const text = await response.text();
        return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
      };
      const slug = aUniqueSlug('__ID__');
      const made = await call('POST', '/api/workspaces', member.cookie, { name: slug, slug });
      const { id } = made.body as { id: string };
      const path = `/api/workspaces/${id}/__ID__`;

      const created = await call('POST', path, member.cookie, { title: ' Ünïcode title ' });
      expect(created.status).toBe(201);
      expect((created.body as __PASCAL__Item).title).toBe('Ünïcode title');
      const listed = await call('GET', path, member.cookie);
      expect(listed.status).toBe(200);
      expect((listed.body as __PASCAL__Item[]).map((row) => row.title)).toEqual(['Ünïcode title']);

      // The same person's other workspace holds a row of its own, which this list does not show.
      const otherSlug = aUniqueSlug('__ID__-other');
      const other = await call('POST', '/api/workspaces', member.cookie, {
        name: otherSlug,
        slug: otherSlug,
      });
      const otherPath = `/api/workspaces/${(other.body as { id: string }).id}/__ID__`;
      expect((await call('POST', otherPath, member.cookie, { title: 'Elsewhere' })).status).toBe(201);
      const again = await call('GET', path, member.cookie);
      expect((again.body as __PASCAL__Item[]).map((row) => row.title)).toEqual(['Ünïcode title']);

      expect((await call('GET', path, stranger.cookie)).status).toBe(404);
      expect((await call('POST', path, stranger.cookie, { title: 'x' })).status).toBe(404);
      expect((await call('GET', path, '')).status).toBe(401);
      for (const title of ['', 'x'.repeat(__UPPER___TITLE_MAX + 1)]) {
        expect((await call('POST', path, member.cookie, { title })).status).toBe(400);
      }
    });
  });
});
