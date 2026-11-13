/** Recovery prelocks both native sources before the workspace and consumes an offline code once across real transactions. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  type ClonedDatabase,
  type Executor,
} from '@purlay/db';
import { companyWorkspaceMfaActor, securityOutcome } from './mfa.testing';
import {
  createWorkspacePolicyRecovery,
  recoverWorkspacePolicy,
  testWorkspacePolicy,
  updateWorkspacePolicy,
} from './policy';
import { enforcedPolicy, freshPolicyActor, workspacePolicyFixture } from './policy.testing';
import { AppError } from '../../../platform/errors';

let owned: ClonedDatabase | undefined;
beforeAll(async () => {
  owned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await owned?.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);
const pidOf = async (db: Executor): Promise<number> => {
  const pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db)).rows[0]?.pid;
  if (pid === undefined) throw new Error('Missing recovery connection');
  return pid;
};

describe('integration: committed policy recovery locks', () => {
  test.each(['session', 'authentication', 'membership'] as const)(
    'a busy %s cap parent aborts the whole save without waiting under the workspace lock',
    async (parent) => {
      if (owned === undefined) throw new Error('Missing recovery database');
      const database = owned;
      const f = await workspacePolicyFixture(database.db);
      await createWorkspacePolicyRecovery(f.dependencies, f.actor, { policyRevision: null });
      const settings = enforcedPolicy({ idleMinutes: 5 });
      const tested = await testWorkspacePolicy(f.dependencies, f.actor, {
        revision: null,
        policy: settings,
      });
      const held = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const blocker = database.db.transaction().execute(async (tx) => {
        if (parent === 'session')
          await tx
            .selectFrom('sessions')
            .select('id')
            .where('id', '=', f.member.sessionId)
            .forUpdate()
            .execute();
        else if (parent === 'authentication')
          await tx
            .selectFrom('session_authentication_evidence')
            .select('session_id')
            .where('session_id', '=', f.member.sessionId)
            .forUpdate()
            .execute();
        else
          await tx
            .selectFrom('workspace_members')
            .select('user_id')
            .where('workspace_id', '=', f.member.context.workspaceId)
            .where('user_id', '=', f.member.context.userId)
            .forUpdate()
            .execute();
        held.resolve(undefined);
        await release.promise;
      });
      await held.promise;
      let outcome: string;
      try {
        outcome = await database.withFreshPool(async (db) => {
          return await db
            .transaction()
            .execute(async (transaction) => {
              await sql`set local statement_timeout = '500ms'`.execute(transaction);
              return await updateWorkspacePolicy(
                { ...f.dependencies, database: transaction },
                f.actor,
                {
                  revision: null,
                  policy: settings,
                  testId: tested.testId,
                  testToken: tested.testToken,
                },
              );
            })
            .then(
              () => 'taken',
              (error: unknown) =>
                error instanceof AppError ? error.body.code : 'unexpected database wait',
            );
        });
      } finally {
        release.resolve(undefined);
        await blocker;
      }
      expect(outcome).toBe('WORKSPACE_SECURITY_CHANGED');
      expect(
        (
          await database.db
            .selectFrom('workspaces')
            .select('access_policy_epoch')
            .where('id', '=', f.actor.context.workspaceId)
            .executeTakeFirstOrThrow()
        ).access_policy_epoch,
      ).toBe('0');
      expect(
        await database.db
          .selectFrom('workspace_session_assurances')
          .select('session_id')
          .where('session_id', '=', f.member.sessionId)
          .execute(),
      ).toEqual([]);
      expect(
        (
          await database.db
            .selectFrom('workspace_access_policy_tests')
            .select('consumed_at')
            .where('id', '=', tested.testId)
            .executeTakeFirstOrThrow()
        ).consumed_at,
      ).toBeNull();
    },
  );

  test('waiting for the old company source never holds the workspace ahead of that source lock', async () => {
    if (owned === undefined) throw new Error('Missing recovery database');
    const database = owned;
    const f = await workspacePolicyFixture(database.db);
    await createWorkspacePolicyRecovery(f.dependencies, f.actor, { policyRevision: null });
    const company = await companyWorkspaceMfaActor(f.dependencies, f.actor);
    const settings = enforcedPolicy({
      signIn: 'company',
      allowedConnectionIds: [company.connectionId],
    });
    const tested = await testWorkspacePolicy(f.dependencies, company.actor, {
      revision: null,
      policy: settings,
    });
    const saved = await updateWorkspacePolicy(f.dependencies, company.actor, {
      revision: null,
      policy: settings,
      testId: tested.testId,
      testToken: tested.testToken,
    });
    const proof = await testWorkspacePolicy(f.dependencies, company.actor, {
      revision: saved.revision,
      policy: settings,
      purpose: 'recovery_setup',
    });
    const independent = await freshPolicyActor(f);
    const held = Promise.withResolvers<number>();
    const release = Promise.withResolvers<undefined>();
    const blocker = database.db.transaction().execute(async (tx) => {
      await tx
        .selectFrom('sessions')
        .select('id')
        .where('id', '=', company.actor.sessionId)
        .forUpdate()
        .execute();
      held.resolve(await pidOf(tx));
      await release.promise;
    });
    const blockerPid = await held.promise;
    const entered = Promise.withResolvers<number>();
    const operation = database.withFreshPool(async (db) => {
      entered.resolve(await pidOf(db));
      return await createWorkspacePolicyRecovery({ ...f.dependencies, database: db }, independent, {
        policyRevision: saved.revision,
        testId: proof.testId,
        testToken: proof.testToken,
      });
    });
    const pending = { finished: false };
    void operation.then(
      () => {
        pending.finished = true;
      },
      () => {
        pending.finished = true;
      },
    );
    try {
      const pid = await entered.promise;
      let observed = false;
      const deadline = performance.now() + 3_000;
      while (!pending.finished && performance.now() < deadline) {
        const blocked = (
          await sql<{ blockers: number[] }>`select pg_blocking_pids(${pid}) as blockers`.execute(
            database.db,
          )
        ).rows[0]?.blockers;
        if (blocked?.includes(blockerPid) === true) {
          observed = true;
          break;
        }
        await Bun.sleep(5);
      }
      expect(observed).toBe(true);
      const workspaceFree = await database.db
        .transaction()
        .execute(async (tx) => {
          await sql`set local lock_timeout = '150ms'`.execute(tx);
          await tx
            .selectFrom('workspaces')
            .select('id')
            .where('id', '=', independent.context.workspaceId)
            .forUpdate()
            .execute();
        })
        .then(
          () => true,
          () => false,
        );
      expect(workspaceFree).toBe(true);
    } finally {
      release.resolve(undefined);
      await blocker;
      await operation.then(
        () => undefined,
        () => undefined,
      );
    }
    expect((await operation).recoveryCode).toHaveLength(43);
  });

  test('two fresh independent sessions can consume the offline recovery generation only once', async () => {
    if (owned === undefined) throw new Error('Missing recovery database');
    const f = await workspacePolicyFixture(owned.db);
    const code = await createWorkspacePolicyRecovery(f.dependencies, f.actor, {
      policyRevision: null,
    });
    const company = await companyWorkspaceMfaActor(f.dependencies, f.actor);
    const settings = enforcedPolicy({
      signIn: 'company',
      allowedConnectionIds: [company.connectionId],
    });
    const tested = await testWorkspacePolicy(f.dependencies, company.actor, {
      revision: null,
      policy: settings,
    });
    const saved = await updateWorkspacePolicy(f.dependencies, company.actor, {
      revision: null,
      policy: settings,
      testId: tested.testId,
      testToken: tested.testToken,
    });
    const a = await freshPolicyActor(f);
    const b = await freshPolicyActor(f);
    const outcomes = await Promise.all([
      securityOutcome(async () => await recoverWorkspacePolicy(f.dependencies, a, code)),
      securityOutcome(async () => await recoverWorkspacePolicy(f.dependencies, b, code)),
    ]);
    expect(outcomes.sort()).toEqual(['WORKSPACE_SECURITY_CHANGED', 'taken']);
    expect(
      (
        await owned.db
          .selectFrom('workspaces')
          .select('access_policy_epoch')
          .where('id', '=', a.context.workspaceId)
          .executeTakeFirstOrThrow()
      ).access_policy_epoch,
    ).toBe(String(BigInt(saved.epoch) + 1n));
    expect(
      await owned.db
        .selectFrom('audit_log')
        .select('id')
        .where('workspace_id', '=', a.context.workspaceId)
        .where('action', '=', 'workspace.security.policy_recovered')
        .execute(),
    ).toHaveLength(1);
  });
});
