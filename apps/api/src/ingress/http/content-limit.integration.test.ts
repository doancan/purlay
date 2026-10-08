/**
 * One limit, three enforcements, one number (D-67).
 *
 * The contract refuses a long message at both doors; the database refuses it for
 * every writer that is not a door. They are separate checks written in separate
 * languages, so the number is bound here: the database must accept exactly what
 * the contract's maximum allows and refuse one more. Change either without the
 * other and this fails.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { MESSAGE_CONTENT_MAX, messageId } from '@purlay/types';
import { createApp } from './app';
import { NOW, testDependencies } from './testing';
import { fixedClock } from '../../platform/clock';
import { issueSession } from '../../modules/auth/sessions';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);

/** A user, a workspace they own, and a channel in it — through the real endpoints. */
const aChannel = async (
  db: Executor,
  name: string,
): Promise<{ cookie: string; userId: string; workspaceId: string; channelId: string }> => {
  const user = await db
    .insertInto('users')
    .values({ email: `${name}@example.test`, username: name, display_name: name })
    .returning('id')
    .executeTakeFirstOrThrow();
  const { token } = await issueSession(db, clock, user.id, 30);
  const cookie = `purlay_session=${token}`;
  const app = createApp(testDependencies({ database: db, clock }));
  const post = async (path: string, body: unknown): Promise<string> => {
    const response = await app.handle(
      new Request(`https://purlay.test${path}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };
  const workspaceId = await post('/api/workspaces', { name, slug: name });
  const channelId = await post(`/api/workspaces/${workspaceId}/channels`, { name: 'general' });
  return { cookie, userId: user.id, workspaceId, channelId };
};

const send = async (
  db: Executor,
  cookie: string,
  channelId: string,
  content: string,
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock })).handle(
    new Request(`https://purlay.test/api/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ id: messageId(NOW), content }),
    }),
  );

describe('integration: the message length limit', () => {
  test('the database accepts exactly the contract’s maximum, and refuses one more', async () => {
    await withRollback(async (db) => {
      const room = await aChannel(db, 'len-db');
      const insert = async (content: string): Promise<void> => {
        await db
          .insertInto('messages')
          .values({
            id: messageId(NOW),
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            sender_id: room.userId,
            content,
            created_at: NOW,
          })
          .execute();
      };

      await insert('x'.repeat(MESSAGE_CONTENT_MAX));
      // Last: a refused statement aborts the transaction, and the harness rolls it
      // back anyway, so nothing may run after it.
      const refused = await insert('x'.repeat(MESSAGE_CONTENT_MAX + 1)).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toMatchObject({ code: '23514', constraint: 'messages_content_length' });
    });
  });

  test('over HTTP, the maximum is written and one more is refused with the field named', async () => {
    await withRollback(async (db) => {
      const room = await aChannel(db, 'len-http');
      expect(
        (await send(db, room.cookie, room.channelId, 'x'.repeat(MESSAGE_CONTENT_MAX))).status,
      ).toBe(201);

      const over = await send(db, room.cookie, room.channelId, 'x'.repeat(MESSAGE_CONTENT_MAX + 1));
      expect(over.status).toBe(400);
      const refusal = (await over.json()) as {
        error: { code: string; details?: { fields?: Record<string, string> } };
      };
      expect(refusal.error.code).toBe('VALIDATION_FAILED');
      expect(Object.keys(refusal.error.details?.fields ?? {})).toEqual(['content']);
    });
  });

  test('over HTTP, a control character JSON would inflate is refused, and pasted whitespace is not', async () => {
    await withRollback(async (db) => {
      const room = await aChannel(db, 'len-ctrl');
      expect((await send(db, room.cookie, room.channelId, 'a\u0000b')).status).toBe(400);
      expect((await send(db, room.cookie, room.channelId, 'trace:\n\tat f()\r\n')).status).toBe(
        201,
      );
    });
  });
});
