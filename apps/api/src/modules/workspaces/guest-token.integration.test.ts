/** The guest token encoding cannot be opened by an older, unrestricted invitation reader. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  withRollback,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
  type Executor,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { aRoom } from '../../testing/rooms';
import { inSavepoint } from '../../testing/attempt';
import { randomToken, tokenDigest } from '../../platform/tokens';

let cloned: ClonedDatabase;
const migration = new URL(
  '../../../../../packages/db/migrations/0100_guest_invitation_token_encoding.sql',
  import.meta.url,
);

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

/** This is the indexed token comparison used by v0.6.1, before any acceptance or membership write. */
const legacyLookup = async (db: Executor, token: string): Promise<string | undefined> =>
  (
    await db
      .selectFrom('workspace_invitations')
      .select('id')
      .where('token_hash', '=', await tokenDigest(token))
      .executeTakeFirst()
  )?.id;

describe('integration: guest invitation token compatibility', () => {
  test('upgrading tags existing guest digests while retaining normal invitations', async () => {
    await withRollback(async (db) => {
      await sql`alter table workspace_invitations drop constraint workspace_invitations_token_is_a_digest`.execute(
        db,
      );
      await sql`alter table workspace_invitations add constraint workspace_invitations_token_is_a_digest check (token_hash ~ '^[0-9a-f]{64}$')`.execute(
        db,
      );
      const room = await aRoom(db, ['owner']);
      const now = new Date();
      const guestToken = randomToken();
      const memberToken = randomToken();
      const guestId = messageId(now);
      const memberId = messageId(now);
      const common = {
        workspace_id: room.workspaceId,
        created_by: room.members['owner']?.userId ?? '',
        created_at: now,
        expires_at: new Date(now.getTime() + 60_000),
      };
      await db
        .insertInto('workspace_invitations')
        .values([
          {
            ...common,
            id: guestId,
            token_hash: await tokenDigest(guestToken),
            access_kind: 'guest',
            guest_email: 'supplier@example.test',
            guest_channels: [room.channelId],
            guest_modules: ['chat'],
          },
          { ...common, id: memberId, token_hash: await tokenDigest(memberToken) },
        ])
        .execute();
      await sql.raw(await Bun.file(migration).text()).execute(db);
      expect(await legacyLookup(db, guestToken)).toBeUndefined();
      expect(await legacyLookup(db, memberToken)).toBe(memberId);
      const guest = await db
        .selectFrom('workspace_invitations')
        .select(['token_hash', 'guest_channels', 'guest_email'])
        .where('id', '=', guestId)
        .executeTakeFirstOrThrow();
      expect(guest).toEqual({
        token_hash: `guest:${await tokenDigest(guestToken)}`,
        guest_channels: [room.channelId],
        guest_email: 'supplier@example.test',
      });
    }, cloned.db);
  });

  test('tagged guest digests never match a legacy lookup, including with a prefixed input', async () => {
    await withRollback(async (db) => {
      // Reapply this constraint in the clone: a fault mutation must exercise its current SQL source.
      await sql.raw(await Bun.file(migration).text()).execute(db);
      const room = await aRoom(db, ['owner']);
      const token = randomToken();
      const digest = await tokenDigest(token);
      const now = new Date();
      const id = messageId(now);
      await db
        .insertInto('workspace_invitations')
        .values({
          id,
          workspace_id: room.workspaceId,
          created_by: room.members['owner']?.userId ?? '',
          created_at: now,
          expires_at: new Date(now.getTime() + 60_000),
          token_hash: `guest:${digest}`,
          access_kind: 'guest',
          guest_email: 'supplier@example.test',
          guest_channels: [room.channelId],
          guest_modules: ['chat'],
        })
        .execute();
      for (const presented of [token, `guest:${token}`, digest, `guest:${digest}`])
        expect(await legacyLookup(db, presented)).toBeUndefined();
      expect(
        (
          await db
            .selectFrom('workspace_invitations')
            .select('id')
            .where('token_hash', '=', `guest:${await tokenDigest(token)}`)
            .executeTakeFirst()
        )?.id,
      ).toBe(id);
    }, cloned.db);
  });

  test('the database refuses an untagged guest digest and a tagged full-member digest', async () => {
    await withRollback(async (db) => {
      await sql.raw(await Bun.file(migration).text()).execute(db);
      const room = await aRoom(db, ['owner']);
      const now = new Date();
      const token = randomToken();
      const digest = await tokenDigest(token);
      const common = {
        workspace_id: room.workspaceId,
        created_by: room.members['owner']?.userId ?? '',
        created_at: now,
        expires_at: new Date(now.getTime() + 60_000),
      };
      const guest = await inSavepoint(
        db,
        async () =>
          await db
            .insertInto('workspace_invitations')
            .values({
              ...common,
              id: messageId(now),
              token_hash: digest,
              access_kind: 'guest',
              guest_email: 'supplier@example.test',
              guest_channels: [room.channelId],
              guest_modules: ['chat'],
            })
            .execute(),
      );
      expect(guest).toMatchObject({
        taken: false,
        error: { constraint: 'workspace_invitations_token_is_a_digest' },
      });
      const member = await inSavepoint(
        db,
        async () =>
          await db
            .insertInto('workspace_invitations')
            .values({
              ...common,
              id: messageId(now),
              token_hash: `guest:${digest}`,
            })
            .execute(),
      );
      expect(member).toMatchObject({
        taken: false,
        error: { constraint: 'workspace_invitations_token_is_a_digest' },
      });
      const id = messageId(now);
      await db
        .insertInto('workspace_invitations')
        .values({ ...common, id, token_hash: digest })
        .execute();
      expect(await legacyLookup(db, token)).toBe(id);
    }, cloned.db);
  });
});
