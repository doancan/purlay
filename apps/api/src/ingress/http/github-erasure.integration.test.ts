/**
 * Erasing an account revokes the person's GitHub App authorization at GitHub (D-246, #993): after the commit, as the
 * App, once for each person's token, best effort — a GitHub that fails, hangs or cannot be reached changes nothing
 * about the erasure, which has deleted the sealed tokens either way, and what is logged never holds a token.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { keepAuthorization } from '../../features/chat/integrations/github-app';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../../platform/config';
import { credentialCipher } from '../../platform/crypto';
import { aRecordingLogger } from '../../testing/doubles';
import { GITHUB_APP_STUB } from '../../testing/github-app-stub';
import { aWorld, PERSON, type Person, type World } from '../../testing/github-world';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const cipher = credentialCipher(DEVELOPMENT_ENCRYPTION_KEY);
const REVOKE = `DELETE /applications/${GITHUB_APP_STUB.clientId}/grant`;

/** The member gives the App their own tokens, as the owner already has. */
const authorizeMember = async (
  world: World,
): Promise<{ accessToken: string; refreshToken: string }> => {
  const tokens = world.github.grantUser();
  await keepAuthorization(
    world.db,
    { clock: { now: () => world.time.now }, cipher },
    world.member.userId,
    { id: PERSON.id + 1, login: 'member-dev' },
    tokens,
  );
  return tokens;
};

const erase = async (world: World, who: Person = world.member): Promise<Response> => {
  const person = await world.db
    .selectFrom('users')
    .select('username')
    .where('id', '=', who.userId)
    .executeTakeFirstOrThrow();
  return await world.call('POST', '/api/me/erase', who, { confirm: person.username });
};

const rowsOf = async (db: Executor, userId: string): Promise<number> =>
  (
    await db
      .selectFrom('github_user_authorizations')
      .select('id')
      .where('user_id', '=', userId)
      .execute()
  ).length;

const revocationWarnings = (lines: Record<string, unknown>[]): Record<string, unknown>[] =>
  lines.filter((line) => String(line['msg']).includes('revoke'));

describe('integration: erasing an account revokes its GitHub App authorization (#993)', () => {
  test('asks GitHub once, as the App, to revoke the erased person’s token, and nobody else’s', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const theirs = await authorizeMember(world);
      const erased = await erase(world);
      expect(erased.status).toBe(204);
      expect(world.github.calls.filter((call) => call === REVOKE)).toHaveLength(1);
      expect(world.github.callers.at(-1)).toBe('client');
      expect(world.github.revoked).toEqual([theirs.accessToken]);
      expect(world.github.takes(theirs.accessToken)).toBe(false);
      expect(await rowsOf(db, world.member.userId)).toBe(0);
      // The owner's authorization is untouched, here and there.
      expect(await rowsOf(db, world.owner.userId)).toBe(1);
    });
  });

  test('a person who never authorized the App costs GitHub no call', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect((await erase(world)).status).toBe(204);
      expect(world.github.calls.filter((call) => call.startsWith('DELETE'))).toEqual([]);
    });
  });

  for (const [what, behaviour] of [
    ['answers 5xx', 'fails'],
    ['never answers', 'hangs'],
  ] as const) {
    test(`a GitHub that ${what} does not stop the erasure: the rows are deleted and the failure is logged`, async () => {
      await withRollback(async (db) => {
        const recording = aRecordingLogger();
        const world = await aWorld(db, { log: recording.log, deadlineMs: 100 });
        const theirs = await authorizeMember(world);
        world.github.behaviour.revoke = behaviour;
        const erased = await erase(world);
        expect(erased.status).toBe(204);
        expect(await rowsOf(db, world.member.userId)).toBe(0);
        const user = await db
          .selectFrom('users')
          .select('deleted_at')
          .where('id', '=', world.member.userId)
          .executeTakeFirstOrThrow();
        expect(user.deleted_at).not.toBeNull();
        const logged = revocationWarnings(recording.lines);
        expect(logged).toHaveLength(1);
        expect(logged[0]?.['level']).toBe('warn');
        const everything = JSON.stringify(recording.lines);
        for (const secret of [
          theirs.accessToken,
          theirs.refreshToken,
          GITHUB_APP_STUB.clientSecret,
        ]) {
          expect(everything).not.toContain(secret);
        }
      });
    });
  }

  test('a GitHub that cannot be reached does not stop the erasure either', async () => {
    await withRollback(async (db) => {
      const recording = aRecordingLogger();
      const world = await aWorld(db, { log: recording.log });
      await authorizeMember(world);
      world.github.behaviour.unreachable = true;
      expect((await erase(world)).status).toBe(204);
      expect(await rowsOf(db, world.member.userId)).toBe(0);
      expect(revocationWarnings(recording.lines)).toHaveLength(1);
    });
  });

  test('a token GitHub refuses to revoke is logged, not thrown, and its row goes', async () => {
    await withRollback(async (db) => {
      const recording = aRecordingLogger();
      const world = await aWorld(db, { log: recording.log });
      const theirs = await authorizeMember(world);
      // Revoked on GitHub already, by the person: the grant is no longer there to delete.
      world.github.revokeUser();
      expect((await erase(world)).status).toBe(204);
      expect(await rowsOf(db, world.member.userId)).toBe(0);
      expect(revocationWarnings(recording.lines)).toHaveLength(1);
      expect(JSON.stringify(recording.lines)).not.toContain(theirs.accessToken);
    });
  });

  test('a server whose settings no longer hold the App has nothing to revoke with: said, and the rows still go', async () => {
    await withRollback(async (db) => {
      const recording = aRecordingLogger();
      const world = await aWorld(db, { log: recording.log, appSettings: false });
      await authorizeMember(world);
      expect((await erase(world)).status).toBe(204);
      expect(await rowsOf(db, world.member.userId)).toBe(0);
      expect(world.github.calls).toEqual([]);
      expect(revocationWarnings(recording.lines)).toHaveLength(1);
    });
  });
});
