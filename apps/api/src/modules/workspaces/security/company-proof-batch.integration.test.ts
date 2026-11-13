/** Final company proofs stay bound to each actual native source in one current SQL snapshot. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback } from '@purlay/db';
import { companyWorkspaceMfaActor, workspaceMfaFixture } from './mfa.testing';
import { systemClock } from '../../../platform/clock';
import { buildCompanyProofBatch, liveCompanySessionProof } from '../../../platform/company-session';

afterAll(closeIntegrationDatabase);

describe('integration: company proof final batches', () => {
  test('personal native sources remain independent and the unrequested proof relation is empty', async () => {
    await withRollback(async (db) => {
      const fixture = await workspaceMfaFixture(db);
      const actor = fixture.actor;
      const batch = buildCompanyProofBatch([actor.sessionId], () => [
        db
          .selectFrom('sessions')
          .innerJoin('workspace_members', 'workspace_members.user_id', 'sessions.user_id')
          .select('sessions.user_id as userId')
          .where('sessions.id', '=', actor.sessionId)
          .where('sessions.revoked_at', 'is', null)
          .where('sessions.company_workspace_id', 'is', null)
          .where('workspace_members.workspace_id', '=', actor.context.workspaceId),
      ]);
      const first = batch.queries[0];
      if (first === undefined) throw new Error('Missing personal source query');
      const query = db
        .with(
          (cte) => cte(batch.name).materialized(),
          () => batch.source,
        )
        .selectFrom(first.as('personal_sources'))
        .selectAll('personal_sources');
      expect(query.compile().sql).not.toContain('workspace_directory_scim_users');
      expect(query.compile().sql).not.toContain('workspace_identity_sessions');
      expect(
        await db
          .with(batch.name, () => batch.source)
          .selectFrom(batch.name)
          .selectAll()
          .execute(),
      ).toEqual([]);
      expect(await query.execute()).toEqual([{ userId: actor.context.userId }]);
      await db
        .updateTable('sessions')
        .set({ revoked_at: fixture.dependencies.clock.now() })
        .where('id', '=', actor.sessionId)
        .execute();
      expect(await query.execute()).toEqual([]);
    });
  });

  test('each native source keeps its own live proof after construction, including provider and foreign bindings', async () => {
    await withRollback(async (db) => {
      const fixture = await workspaceMfaFixture(db);
      const foreign = await workspaceMfaFixture(db);
      const dependencies = { ...fixture.dependencies, clock: systemClock };
      const a = await companyWorkspaceMfaActor(dependencies, fixture.actor);
      const b = await companyWorkspaceMfaActor(dependencies, fixture.actor);
      const userId = fixture.actor.context.userId;
      const workspaceId = fixture.actor.context.workspaceId;
      const batch = buildCompanyProofBatch([a.actor.sessionId, b.actor.sessionId], () =>
        [
          {
            key: 'a',
            sessionId: a.actor.sessionId,
            workspaceId: sql<string>`${workspaceId}`,
            userId,
          },
          { key: 'b', sessionId: b.actor.sessionId, workspaceId, userId },
          {
            key: 'foreign-workspace',
            sessionId: a.actor.sessionId,
            workspaceId: foreign.actor.context.workspaceId,
            userId,
          },
          {
            key: 'foreign-user',
            sessionId: a.actor.sessionId,
            workspaceId,
            userId: fixture.member.context.userId,
          },
          {
            key: 'foreign-connection',
            sessionId: a.actor.sessionId,
            workspaceId,
            userId,
            connectionId: b.connectionId,
          },
          { key: 'unknown-source', sessionId: crypto.randomUUID(), workspaceId, userId },
        ]
          .map(
            (row) => sql<{ key: string; allowed: boolean }>`(select ${row.key}::text as key,
          ${liveCompanySessionProof(row.sessionId, row.workspaceId, row.userId, row.connectionId)} as allowed)`,
          )
          .concat([
            sql<{ key: string; allowed: boolean }>`(select 'personal-source'::text as key,
            exists(select 1 from sessions where id = ${fixture.actor.sessionId}::uuid
              and user_id = ${userId}::uuid and company_workspace_id is null
              and revoked_at is null) as allowed)`,
          ]),
      );
      const first = batch.queries[0];
      if (first === undefined) throw new Error('Missing actual company source queries');
      let query = db
        .with(
          (cte) => cte(batch.name).materialized(),
          () => batch.source,
        )
        .selectFrom(first.as('batch_checks'))
        .selectAll('batch_checks');
      for (const next of batch.queries.slice(1)) query = query.unionAll(next);
      await db
        .updateTable('workspace_identity_sessions')
        .set({ revoked_at: systemClock.now() })
        .where('session_id', '=', b.actor.sessionId)
        .execute();
      expect(
        Object.fromEntries((await query.execute()).map((row) => [row.key, row.allowed])),
      ).toEqual({
        a: true,
        'personal-source': true,
        b: false,
        'foreign-workspace': false,
        'foreign-user': false,
        'foreign-connection': false,
        'unknown-source': false,
      });
      // The construction context has ended: this independent statement still uses canonical SQL.
      expect(
        await db
          .selectNoFrom(
            liveCompanySessionProof(b.actor.sessionId, workspaceId, userId).as('allowed'),
          )
          .executeTakeFirstOrThrow(),
      ).toEqual({ allowed: false });
      await db
        .updateTable('workspace_identity_connections')
        .set({ enabled: false })
        .where('id', '=', a.connectionId)
        .execute();
      expect(
        (await query.execute())
          .filter((row) => row.key !== 'personal-source')
          .every((row) => !row.allowed),
      ).toBe(true);
    });
  });
});
