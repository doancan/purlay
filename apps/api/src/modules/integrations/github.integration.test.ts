/**
 * The workspace's GitHub credential (D-11, D-23, D-39 §6, #65): one per workspace, sealed with the
 * row's id bound in, never returned and never written anywhere in the clear — not in the row, not
 * in the audit trail. Managing it is an owner's or an admin's.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { credentialCipher } from '../../platform/crypto';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import { aRoom, type Room } from '../../testing/rooms';
import { githubIntegrationOf, removeGitHubToken, setGitHubToken } from './github';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
const cipher = credentialCipher(Buffer.alloc(32, 9).toString('base64'));
const TOKEN = 'ghp_s3cretT0kenThatMustNeverBeSeen';

const as = async (db: Executor, room: Room, name: string): Promise<WorkspaceContext> => {
  const member = room.members[name];
  if (member === undefined) throw new Error(`no ${name}`);
  return await requireWorkspaceMembership(db, member.userId, room.workspaceId);
};

const stored = async (
  db: Executor,
  room: Room,
): Promise<{ id: string; access_token_encrypted: string | null } | undefined> =>
  await db
    .selectFrom('github_integrations')
    .select(['id', 'access_token_encrypted'])
    .where('workspace_id', '=', room.workspaceId)
    .executeTakeFirst();

describe('integration: the workspace’s GitHub token', () => {
  test('is sealed for its row and opens only there; it is never in the clear, nor in the trail', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = await as(db, room, 'alice');
      expect(await githubIntegrationOf(db, alice)).toEqual({
        configured: false,
        updatedAt: null,
        invalidSince: null,
        broadScopes: false,
      });

      await setGitHubToken(db, clock, cipher, alice, TOKEN);
      const row = await stored(db, room);
      if (row?.access_token_encrypted == null) throw new Error('not stored');
      expect(row.access_token_encrypted).not.toContain(TOKEN);
      const sealed = Buffer.from(row.access_token_encrypted, 'base64');
      expect(await cipher.open(sealed, row.id)).toBe(TOKEN);
      expect(await githubIntegrationOf(db, alice)).toEqual({
        configured: true,
        updatedAt: NOW.toISOString(),
        invalidSince: null,
        broadScopes: false,
      });
      const trail = await db
        .selectFrom('audit_log')
        .select(['action', 'metadata'])
        .where('workspace_id', '=', room.workspaceId)
        .execute();
      expect(trail.map((entry) => entry.action)).toEqual(['integration.token_set']);
      expect(JSON.stringify(trail)).not.toContain(TOKEN);
    });
  });

  test('replaced, keeps its row: the new token opens for the same id, the old one is gone', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = await as(db, room, 'alice');
      await setGitHubToken(db, clock, cipher, alice, 'ghp_first');
      const before = await stored(db, room);
      await setGitHubToken(db, clock, cipher, alice, 'ghp_second');
      const after = await stored(db, room);
      expect(after?.id).toBe(before?.id);
      expect(
        await cipher.open(
          Buffer.from(after?.access_token_encrypted ?? '', 'base64'),
          after?.id ?? '',
        ),
      ).toBe('ghp_second');
    });
  });

  test('the scopes it was saved with say whether it is broad; a replacement forgets the last one’s', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = await as(db, room, 'alice');
      await setGitHubToken(db, clock, cipher, alice, 'ghp_classic', 'repo, read:org');
      expect(await githubIntegrationOf(db, alice)).toMatchObject({ broadScopes: true });
      await setGitHubToken(db, clock, cipher, alice, 'ghp_narrow', 'read:user');
      expect(await githubIntegrationOf(db, alice)).toMatchObject({ broadScopes: false });
      await setGitHubToken(db, clock, cipher, alice, 'ghp_classic_again', 'workflow');
      await setGitHubToken(db, clock, cipher, alice, 'github_pat_fine');
      expect(await githubIntegrationOf(db, alice)).toMatchObject({ broadScopes: false });
      expect((await stored(db, room))?.access_token_encrypted).not.toBeNull();
    });
  });

  test('removed, is gone and says so once; removing nothing records nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = await as(db, room, 'alice');
      await removeGitHubToken(db, clock, alice);
      await setGitHubToken(db, clock, cipher, alice, TOKEN);
      await removeGitHubToken(db, clock, alice);
      await removeGitHubToken(db, clock, alice);
      expect((await stored(db, room))?.access_token_encrypted).toBeNull();
      expect(await githubIntegrationOf(db, alice)).toMatchObject({ configured: false });
      const actions = await db
        .selectFrom('audit_log')
        .select('action')
        .where('workspace_id', '=', room.workspaceId)
        .orderBy('id')
        .execute();
      expect(actions.map((entry) => entry.action).sort()).toEqual([
        'integration.token_removed',
        'integration.token_set',
      ]);
    });
  });

  test('is an owner’s or an admin’s to see, set or remove; a member is refused', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = await as(db, room, 'bob');
      const refused = async (attempt: Promise<unknown>): Promise<string> =>
        await attempt.then(
          () => 'accepted',
          (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
        );
      expect(await refused(githubIntegrationOf(db, bob))).toBe('FORBIDDEN');
      expect(await refused(setGitHubToken(db, clock, cipher, bob, TOKEN))).toBe('FORBIDDEN');
      expect(await refused(removeGitHubToken(db, clock, bob))).toBe('FORBIDDEN');
      expect(await stored(db, room)).toBeUndefined();
    });
  });
});
