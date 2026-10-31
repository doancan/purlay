/**
 * Erasing an account while the same person sends (D-139 §5), on a cloned database with real
 * connections — inside the harness's one transaction nothing races (D-46, D-77). The send holds its
 * session, then names its author; the erasure takes the sessions before the person's row, the same
 * order, so the two take turns and neither is a deadlock's victim: the send lands first, or is told to
 * sign in; the erasure is done either way. A trigger that sleeps holds the send inside its window.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, sql, type ClonedDatabase, CLONE_HOOK_MS } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { NOW, testDependencies } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { SESSION_COOKIE } from '../../platform/cookies';
import { aSession } from '../../testing/signed-in';
import { createApp } from './app';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  await sql`
    create function hold_window() returns trigger language plpgsql as
    $$ begin perform pg_sleep(0.3); return new; end $$
  `.execute(cloned.db);
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
});

const ORIGIN = 'https://purlay.test';
const clock = fixedClock(NOW);

describe('integration: erasing an account while it sends', () => {
  test('the send lands or is told to sign in; the erasure is done; nobody meets a deadlock', async () => {
    // bob owns the workspace, so ada may go.
    const room = await aRoom(cloned.db, ['bob', 'ada']);
    const ada = room.members['ada'];
    if (ada === undefined) throw new Error('no ada');
    const { token } = await aSession(cloned.db, clock, ada.userId, 30);
    const cookie = `${SESSION_COOKIE}=${token}`;
    const app = createApp(testDependencies({ database: cloned.db, clock }));
    const post = (path: string, body: unknown): Request =>
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    await sql`create trigger hold before insert on messages for each row execute function hold_window()`.execute(
      cloned.db,
    );
    let answers: Response[];
    try {
      answers = await Promise.all([
        app.handle(
          post(`/api/channels/${room.channelId}/messages`, {
            id: messageId(NOW),
            content: 'last words',
          }),
        ),
        app.handle(post('/api/me/erase', { confirm: ada.username })),
      ]);
    } finally {
      await sql`drop trigger hold on messages`.execute(cloned.db);
    }
    const [sent, erased] = answers;
    expect(erased?.status).toBe(204);
    expect([201, 401]).toContain(sent?.status ?? 0);
    const row = await cloned.db
      .selectFrom('users')
      .select('deleted_at')
      .where('id', '=', ada.userId)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
  });
});
