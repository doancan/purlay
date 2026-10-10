/**
 * The two readers a page of messages is built from, against a real database.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { aDatabaseThatMustNotBeTouched } from '../../testing/doubles';
import { mentionSets, reactionSets } from './sets';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const seed = async (
  db: Executor,
): Promise<{ workspaceId: string; channelId: string; users: string[] }> => {
  const users: string[] = [];
  for (const name of ['sets-a', 'sets-b', 'sets-c']) {
    const row = await db
      .insertInto('users')
      .values({ email: `${name}@example.test`, username: name, display_name: name })
      .returning('id')
      .executeTakeFirstOrThrow();
    users.push(row.id);
  }
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'sets', slug: 'sets' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const channel = await db
    .insertInto('channels')
    .values({ workspace_id: workspace.id, name: 'general', type: 'public' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { workspaceId: workspace.id, channelId: channel.id, users };
};

const addMessage = async (
  db: Executor,
  scope: { workspaceId: string; channelId: string },
  sender: string,
): Promise<string> => {
  const id = Bun.randomUUIDv7();
  await db
    .insertInto('messages')
    .values({
      id,
      workspace_id: scope.workspaceId,
      channel_id: scope.channelId,
      sender_id: sender,
      content: 'x',
    })
    .execute();
  return id;
};

describe('integration: reaction sets', () => {
  test('groups people by emoji, per message, in the order they reacted', async () => {
    await withRollback(async (db) => {
      const scope = await seed(db);
      const [a, b, c] = scope.users as [string, string, string];
      const one = await addMessage(db, scope, a);
      const two = await addMessage(db, scope, a);
      const at = (seconds: number): Date => new Date(Date.UTC(2026, 8, 9, 12, 0, seconds));
      const react = async (
        message: string,
        user: string,
        emoji: string,
        seconds: number,
      ): Promise<void> => {
        await db
          .insertInto('reactions')
          .values({ message_id: message, user_id: user, emoji, created_at: at(seconds) })
          .execute();
      };
      await react(one, b, '🎉', 1);
      await react(one, a, '👍', 2);
      await react(one, c, '👍', 3);
      await react(one, b, '👍', 4);
      await react(two, c, '❤️', 5);

      const sets = await reactionSets(db, [one, two, Bun.randomUUIDv7()]);
      expect(sets.get(one)).toEqual([
        { emoji: '🎉', userIds: [b] },
        { emoji: '👍', userIds: [a, c, b] },
      ]);
      expect(sets.get(two)).toEqual([{ emoji: '❤️', userIds: [c] }]);
      expect(sets.size).toBe(2);
    });
  });

  test('asking for no messages asks the database nothing', async () => {
    const mustNotBeTouched = aDatabaseThatMustNotBeTouched();
    expect((await reactionSets(mustNotBeTouched, [])).size).toBe(0);
    expect((await mentionSets(mustNotBeTouched, [])).size).toBe(0);
  });
});

describe('integration: mention sets', () => {
  test('lists the people each message names, and none for a message that names nobody', async () => {
    await withRollback(async (db) => {
      const scope = await seed(db);
      const [a, b, c] = scope.users as [string, string, string];
      const named = await addMessage(db, scope, a);
      const quiet = await addMessage(db, scope, a);
      for (const user of [b, c]) {
        await db
          .insertInto('mentions')
          .values({
            workspace_id: scope.workspaceId,
            channel_id: scope.channelId,
            message_id: named,
            mentioned_user_id: user,
          })
          .execute();
      }
      const sets = await mentionSets(db, [named, quiet]);
      expect([...(sets.get(named) ?? [])].sort()).toEqual([b, c].sort());
      expect(sets.has(quiet)).toBe(false);
    });
  });
});
