/**
 * Tenant integrity is a constraint, not a convention (D-90).
 *
 * Every test here attempts a violation and expects the database to refuse it, by
 * the name of the constraint that did. A test that only checked "it threw" would
 * pass for a missing column as readily as for the rule under test, and the refusal
 * the audit found accepted all of these (#242).
 *
 * A refused statement aborts its transaction, so each test attempts exactly one
 * violation, inside a transaction that is rolled back (D-46).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import pg from 'pg';
import type { Executor } from './client';
import { closeIntegrationDatabase, integrationDatabase, withRollback } from './testing';

afterAll(async () => {
  await closeIntegrationDatabase();
});

interface Refusal {
  readonly code: string;
  readonly constraint: string;
}

/** What the database said, or a failure of the test if it said nothing. */
const refusedWith = async (attempt: () => Promise<unknown>): Promise<Refusal> => {
  try {
    await attempt();
  } catch (error) {
    if (error instanceof pg.DatabaseError) {
      return { code: error.code ?? '', constraint: error.constraint ?? '' };
    }
    throw error;
  }
  throw new Error('the database accepted what it should have refused');
};

const FOREIGN_KEY = '23503';
const CHECK = '23514';
/** `ON DELETE RESTRICT` reports its own class, not a foreign-key violation. */
const RESTRICT = '23001';

interface Tenants {
  readonly userId: string;
  readonly workspaceA: string;
  readonly workspaceB: string;
  readonly channelA: string;
  readonly channelB: string;
  readonly messageA: string;
  readonly messageB: string;
}

const uuid = async (
  db: Executor,
  expression: 'uuidv7()' | 'gen_random_uuid()',
): Promise<string> => {
  const { rows } = await sql<{ id: string }>`select ${sql.raw(expression)} as id`.execute(db);
  return rows[0]?.id ?? '';
};

/** Two workspaces, a channel and a message in each: valid rows to violate against. */
const twoTenants = async (db: Executor): Promise<Tenants> => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db
    .insertInto('users')
    .values({ email: `c-${suffix}@example.test`, username: `c-${suffix}`, display_name: 'C' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const workspace = async (name: string): Promise<string> =>
    (
      await db
        .insertInto('workspaces')
        .values({ name, slug: `${name}-${suffix}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const workspaceA = await workspace('a');
  const workspaceB = await workspace('b');
  const channel = async (workspaceId: string): Promise<string> =>
    (
      await db
        .insertInto('channels')
        .values({ workspace_id: workspaceId, name: 'general', type: 'public' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const channelA = await channel(workspaceA);
  const channelB = await channel(workspaceB);
  const message = async (workspaceId: string, channelId: string): Promise<string> => {
    const id = await uuid(db, 'uuidv7()');
    await db
      .insertInto('messages')
      .values({
        id,
        workspace_id: workspaceId,
        channel_id: channelId,
        sender_id: user.id,
        content: 'hello',
      })
      .execute();
    return id;
  };
  return {
    userId: user.id,
    workspaceA,
    workspaceB,
    channelA,
    channelB,
    messageA: await message(workspaceA, channelA),
    messageB: await message(workspaceB, channelB),
  };
};

describe('integration: a message belongs to the tenant of its channel', () => {
  test('a message cannot name a channel of another workspace (I-4)', async () => {
    await withRollback(async (db) => {
      const t = await twoTenants(db);
      const refusal = await refusedWith(
        async () =>
          await db
            .insertInto('messages')
            .values({
              id: await uuid(db, 'uuidv7()'),
              workspace_id: t.workspaceA,
              channel_id: t.channelB,
              sender_id: t.userId,
              content: 'leak',
            })
            .execute(),
      );
      expect(refusal).toEqual({ code: FOREIGN_KEY, constraint: 'messages_channel_workspace_fkey' });
    });
  });

  test('a message cannot be moved to another workspace while it stays in its channel', async () => {
    await withRollback(async (db) => {
      const t = await twoTenants(db);
      const refusal = await refusedWith(
        async () =>
          await db
            .updateTable('messages')
            .set({ workspace_id: t.workspaceB })
            .where('id', '=', t.messageA)
            .execute(),
      );
      expect(refusal).toEqual({ code: FOREIGN_KEY, constraint: 'messages_channel_workspace_fkey' });
    });
  });

  test('a reply must be in its parent’s channel (I-1, in part)', async () => {
    await withRollback(async (db) => {
      const t = await twoTenants(db);
      const refusal = await refusedWith(
        async () =>
          await db
            .insertInto('messages')
            .values({
              id: await uuid(db, 'uuidv7()'),
              workspace_id: t.workspaceB,
              channel_id: t.channelB,
              parent_id: t.messageA,
              sender_id: t.userId,
              content: 'reply across tenants',
            })
            .execute(),
      );
      expect(refusal).toEqual({ code: FOREIGN_KEY, constraint: 'messages_parent_channel_fkey' });
    });
  });

  test('a parent with replies cannot be deleted (D-9), and a reply in its channel is accepted', async () => {
    await withRollback(async (db) => {
      const t = await twoTenants(db);
      await db
        .insertInto('messages')
        .values({
          id: await uuid(db, 'uuidv7()'),
          workspace_id: t.workspaceA,
          channel_id: t.channelA,
          parent_id: t.messageA,
          sender_id: t.userId,
          content: 'a proper reply',
        })
        .execute();
      const refusal = await refusedWith(
        async () => await db.deleteFrom('messages').where('id', '=', t.messageA).execute(),
      );
      expect(refusal).toEqual({ code: RESTRICT, constraint: 'messages_parent_channel_fkey' });
    });
  });

  test('a read position must be a message of that channel (I-3)', async () => {
    await withRollback(async (db) => {
      const t = await twoTenants(db);
      const refusal = await refusedWith(
        async () =>
          await db
            .insertInto('channel_members')
            .values({
              channel_id: t.channelB,
              user_id: t.userId,
              last_read_message_id: t.messageA,
            })
            .execute(),
      );
      expect(refusal).toEqual({
        code: FOREIGN_KEY,
        constraint: 'channel_members_last_read_channel_fkey',
      });
    });
  });

  /**
   * The composite key must not make deleting a message impossible, nor null the
   * channel the membership belongs to: `ON DELETE SET NULL` on two columns would do
   * both, which is why the action names the one column it clears.
   */
  test('deleting the message someone last read clears only that position', async () => {
    await withRollback(async (db) => {
      const t = await twoTenants(db);
      await db
        .insertInto('channel_members')
        .values({ channel_id: t.channelA, user_id: t.userId, last_read_message_id: t.messageA })
        .execute();
      await db.deleteFrom('messages').where('id', '=', t.messageA).execute();
      const member = await db
        .selectFrom('channel_members')
        .select(['channel_id', 'last_read_message_id'])
        .where('channel_id', '=', t.channelA)
        .where('user_id', '=', t.userId)
        .executeTakeFirstOrThrow();
      expect(member).toEqual({ channel_id: t.channelA, last_read_message_id: null });
    });
  });

  test('deleting a channel still takes its messages and memberships with it', async () => {
    await withRollback(async (db) => {
      const t = await twoTenants(db);
      await db
        .insertInto('channel_members')
        .values({ channel_id: t.channelA, user_id: t.userId, last_read_message_id: t.messageA })
        .execute();
      await db.deleteFrom('channels').where('id', '=', t.channelA).execute();
      const left = await db
        .selectFrom('messages')
        .select('id')
        .where('channel_id', '=', t.channelA)
        .execute();
      expect(left).toEqual([]);
      const members = await db
        .selectFrom('channel_members')
        .select('id')
        .where('channel_id', '=', t.channelA)
        .execute();
      expect(members).toEqual([]);
    });
  });
});

describe('integration: what the database says about an id and a DM key', () => {
  const insertWithId = async (db: Executor, t: Tenants, id: string): Promise<void> => {
    await db
      .insertInto('messages')
      .values({
        id,
        workspace_id: t.workspaceA,
        channel_id: t.channelA,
        sender_id: t.userId,
        content: 'x',
      })
      .execute();
  };

  test('a message id that is not a UUIDv7 is refused (D-8)', async () => {
    await withRollback(async (db) => {
      const t = await twoTenants(db);
      const v4 = await uuid(db, 'gen_random_uuid()');
      const refusal = await refusedWith(async () => {
        await insertWithId(db, t, v4);
      });
      expect(refusal).toEqual({ code: CHECK, constraint: 'messages_id_is_uuidv7' });
    });
  });

  test('a version 7 id without the RFC variant bits is refused', async () => {
    await withRollback(async (db) => {
      const t = await twoTenants(db);
      const wrongVariant = '0199155c-6200-7b7f-c811-2a4d3f9e1b70';
      const refusal = await refusedWith(async () => {
        await insertWithId(db, t, wrongVariant);
      });
      expect(refusal).toEqual({ code: CHECK, constraint: 'messages_id_is_uuidv7' });
    });
  });

  test('a UUIDv7 is accepted', async () => {
    await withRollback(async (db) => {
      const t = await twoTenants(db);
      await insertWithId(db, t, await uuid(db, 'uuidv7()'));
    });
  });

  const insertDm = async (db: Executor, workspaceId: string, dmKey: string): Promise<void> => {
    await db
      .insertInto('channels')
      .values({ workspace_id: workspaceId, name: null, type: 'direct_message', dm_key: dmKey })
      .execute();
  };

  test('a DM key that is not two member ids is refused (I-5)', async () => {
    await withRollback(async (db) => {
      const t = await twoTenants(db);
      const refusal = await refusedWith(async () => {
        await insertDm(db, t.workspaceA, 'garbage');
      });
      expect(refusal).toEqual({ code: CHECK, constraint: 'dm_key_form' });
    });
  });

  test('a DM key whose pair is not sorted ascending is refused', async () => {
    await withRollback(async (db) => {
      const t = await twoTenants(db);
      const [low, high] = [t.userId, await uuid(db, 'gen_random_uuid()')].sort();
      const refusal = await refusedWith(async () => {
        await insertDm(db, t.workspaceA, `${high ?? ''}:${low ?? ''}`);
      });
      expect(refusal).toEqual({ code: CHECK, constraint: 'dm_key_form' });
    });
  });

  test('a DM key in upper case is refused, since the key is compared byte for byte', async () => {
    await withRollback(async (db) => {
      const t = await twoTenants(db);
      const [low, high] = [t.userId, await uuid(db, 'gen_random_uuid()')].sort();
      const refusal = await refusedWith(async () => {
        await insertDm(db, t.workspaceA, `${low ?? ''}:${high ?? ''}`.toUpperCase());
      });
      expect(refusal).toEqual({ code: CHECK, constraint: 'dm_key_form' });
    });
  });

  test('a sorted pair of lower-case ids is accepted', async () => {
    await withRollback(async (db) => {
      const t = await twoTenants(db);
      const [low, high] = [t.userId, await uuid(db, 'gen_random_uuid()')].sort();
      await insertDm(db, t.workspaceA, `${low ?? ''}:${high ?? ''}`);
    });
  });
});

describe('integration: nothing is left unvalidated', () => {
  /**
   * `NOT VALID` is how a constraint is added to a large table without locking it,
   * and a constraint left that way checks new rows only. The migration validates
   * in its next statement; this is the proof it did, read from the catalogue.
   */
  test('every constraint in the schema has been validated', async () => {
    const { rows } = await sql<{ table: string; name: string }>`
      select conrelid::regclass::text as "table", conname as name
      from pg_constraint
      where connamespace = 'public'::regnamespace and not convalidated`.execute(
      integrationDatabase(),
    );
    expect(rows).toEqual([]);
  });
});
