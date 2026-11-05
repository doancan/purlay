/**
 * Erasing an account revokes the person's GitHub App authorization at GitHub (D-246, #993): after the commit, as the
 * App, once for each person's token, best effort — a GitHub that fails, hangs or cannot be reached changes nothing
 * about the erasure, which has deleted the sealed tokens either way, and what is logged never holds a token. And it
 * takes the person's own GitHub login out of the installation of the App on their personal account (#997).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { ERASED_USERNAME_PREFIX } from '@purlay/types';
import { keepAuthorization } from '../../features/chat/integrations/github-app';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../../platform/config';
import { credentialCipher } from '../../platform/crypto';
import { recordAudit } from '../../modules/audit/audit';
import { aRecordingLogger } from '../../testing/doubles';
import { GITHUB_APP_STUB } from '../../testing/github-app-stub';
import { aRoom } from '../../testing/rooms';
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

describe('integration: an expired access token is renewed with the refresh token before the revoke (#1000)', () => {
  /** Everything the database and the log would show a reader of what the erasure left, as one string. */
  const leftBehind = async (
    db: Executor,
    userId: string,
    lines: Record<string, unknown>[],
  ): Promise<string> =>
    JSON.stringify([
      lines,
      await db.selectFrom('audit_log').selectAll().where('actor_user_id', '=', userId).execute(),
    ]);

  test('an access token GitHub refuses as expired is replaced by a refresh, and the grant is revoked with the new one', async () => {
    await withRollback(async (db) => {
      const recording = aRecordingLogger();
      const world = await aWorld(db, { log: recording.log });
      const theirs = await authorizeMember(world);
      world.github.expireUserTokens();
      expect((await erase(world)).status).toBe(204);
      expect(await rowsOf(db, world.member.userId)).toBe(0);
      expect(world.github.refreshed).toEqual([theirs.refreshToken]);
      // The sealed token was tried first and refused; what was revoked is the one the refresh gave.
      expect(world.github.calls.filter((call) => call === REVOKE)).toHaveLength(2);
      const [renewed] = world.github.revoked;
      expect(world.github.revoked).toHaveLength(1);
      expect(renewed).not.toBe(theirs.accessToken);
      expect(world.github.takes(renewed ?? '')).toBe(false);
      expect(world.github.takes(theirs.accessToken)).toBe(false);
      expect(recording.lines.filter((line) => line['level'] === 'warn')).toEqual([]);
      expect(
        revocationWarnings(recording.lines).map((line) => [line['level'], line['msg']]),
      ).toEqual([
        ['info', 'github app authorization revoked at GitHub with a renewed access token'],
      ]);
      const everything = await leftBehind(db, world.member.userId, recording.lines);
      for (const secret of [
        theirs.accessToken,
        theirs.refreshToken,
        renewed ?? '',
        GITHUB_APP_STUB.clientSecret,
      ]) {
        expect(everything).not.toContain(secret);
      }
    });
  });

  test('a valid access token is revoked as it is: no refresh is spent', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const theirs = await authorizeMember(world);
      expect((await erase(world)).status).toBe(204);
      expect(world.github.refreshed).toEqual([]);
      expect(world.github.revoked).toEqual([theirs.accessToken]);
    });
  });

  test('a refresh token GitHub refuses too is logged as that, and the erasure still completes', async () => {
    await withRollback(async (db) => {
      const recording = aRecordingLogger();
      const world = await aWorld(db, { log: recording.log });
      const theirs = await authorizeMember(world);
      world.github.expireUserTokens();
      world.github.behaviour.refresh = 'refuses';
      expect((await erase(world)).status).toBe(204);
      expect(await rowsOf(db, world.member.userId)).toBe(0);
      expect(world.github.revoked).toEqual([]);
      const logged = revocationWarnings(recording.lines);
      expect(logged).toHaveLength(1);
      expect(logged[0]?.['level']).toBe('warn');
      expect(String(logged[0]?.['reason'])).toContain('refresh token');
      const everything = await leftBehind(db, world.member.userId, recording.lines);
      for (const secret of [
        theirs.accessToken,
        theirs.refreshToken,
        GITHUB_APP_STUB.clientSecret,
      ]) {
        expect(everything).not.toContain(secret);
      }
    });
  });

  test('a person with an expired access token and no refresh token has nothing to renew: said, and the rows go', async () => {
    await withRollback(async (db) => {
      const recording = aRecordingLogger();
      const world = await aWorld(db, { log: recording.log });
      await authorizeMember(world);
      await db
        .updateTable('github_user_authorizations')
        .set({ refresh_token_encrypted: null, refresh_expires_at: null })
        .where('user_id', '=', world.member.userId)
        .execute();
      world.github.expireUserTokens();
      expect((await erase(world)).status).toBe(204);
      expect(world.github.refreshed).toEqual([]);
      expect(revocationWarnings(recording.lines)).toHaveLength(1);
      expect(await rowsOf(db, world.member.userId)).toBe(0);
    });
  });

  for (const [what, behaviour] of [
    ['answers 5xx', 'fails'],
    ['never answers', 'hangs'],
  ] as const) {
    test(`a GitHub that ${what} to the refresh is waited on once, within the deadline, and the erasure completes`, async () => {
      await withRollback(async (db) => {
        const recording = aRecordingLogger();
        const world = await aWorld(db, { log: recording.log, deadlineMs: 100 });
        await authorizeMember(world);
        world.github.expireUserTokens();
        world.github.behaviour.refresh = behaviour;
        const started = Date.now();
        expect((await erase(world)).status).toBe(204);
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(world.github.refreshed).toHaveLength(1);
        expect(await rowsOf(db, world.member.userId)).toBe(0);
        expect(revocationWarnings(recording.lines)).toHaveLength(1);
      });
    });
  }

  test('a GitHub that is down for the revoke is not asked for a refresh: it would only wait twice', async () => {
    await withRollback(async (db) => {
      const recording = aRecordingLogger();
      const world = await aWorld(db, { log: recording.log });
      await authorizeMember(world);
      world.github.expireUserTokens();
      world.github.behaviour.revoke = 'fails';
      expect((await erase(world)).status).toBe(204);
      expect(world.github.refreshed).toEqual([]);
      expect(revocationWarnings(recording.lines)).toHaveLength(1);
    });
  });
});

type AccountKind = 'User' | 'Organization';

const connect = async (
  db: Executor,
  workspaceId: string,
  connectedBy: string,
  login: string,
  kind: AccountKind,
): Promise<void> => {
  await db
    .insertInto('github_app_installations')
    .values({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      installation_id: String(1000 + login.length),
      account_login: login,
      account_type: kind,
      connected_by: connectedBy,
      connected_at: new Date('2026-01-01T00:00:00Z'),
    })
    .execute();
};

const loginOf = async (db: Executor, workspaceId: string): Promise<string> =>
  (
    await db
      .selectFrom('github_app_installations')
      .select('account_login')
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirstOrThrow()
  ).account_login;

describe('integration: erasing an account clears its GitHub login from the installation (#997)', () => {
  test('the login of a personal-account installation the person connected is replaced; nobody else’s, and no organisation’s, is', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, { installed: false });
      const second = await aRoom(db, ['someone']);
      const third = await aRoom(db, ['someone']);
      const someone = second.members['someone']?.userId ?? '';
      // Theirs: the App on their own account. Another person's own account, and an organisation the erased
      // person connected (its login names the organisation, not them), stay as they are.
      await connect(db, world.workspaceId, world.member.userId, 'ayse-dev', 'User');
      await connect(db, second.workspaceId, someone, 'other-dev', 'User');
      await connect(db, third.workspaceId, world.member.userId, 'acme-corp', 'Organization');
      expect((await erase(world)).status).toBe(204);

      const erasedName = (
        await db
          .selectFrom('users')
          .select('username')
          .where('id', '=', world.member.userId)
          .executeTakeFirstOrThrow()
      ).username;
      expect(erasedName.startsWith(ERASED_USERNAME_PREFIX)).toBe(true);
      expect(await loginOf(db, world.workspaceId)).toBe(erasedName);
      expect(await loginOf(db, second.workspaceId)).toBe('other-dev');
      expect(await loginOf(db, third.workspaceId)).toBe('acme-corp');
      // The installation itself is the workspace's: its id, its kind and who connected it are as they were.
      const kept = await db
        .selectFrom('github_app_installations')
        .select(['installation_id', 'account_type', 'connected_by'])
        .where('workspace_id', '=', world.workspaceId)
        .executeTakeFirstOrThrow();
      expect(kept).toEqual({
        installation_id: String(1000 + 'ayse-dev'.length),
        account_type: 'User',
        connected_by: world.member.userId,
      });
    });
  });

  test('the trail keeps its line, append-only (I-9): it names the login as it was written', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, { installed: false });
      await connect(db, world.workspaceId, world.member.userId, 'ayse-dev', 'User');
      await recordAudit(
        db,
        { now: () => world.time.now },
        {
          workspaceId: world.workspaceId,
          actorUserId: world.member.userId,
          action: 'integration.app_connected',
          targetType: 'integration',
          targetId: world.workspaceId,
          metadata: { account: 'ayse-dev' },
        },
      );
      expect((await erase(world)).status).toBe(204);
      const line = await db
        .selectFrom('audit_log')
        .select('metadata')
        .where('action', '=', 'integration.app_connected')
        .executeTakeFirstOrThrow();
      expect(line.metadata).toEqual({ account: 'ayse-dev' });
    });
  });
});
