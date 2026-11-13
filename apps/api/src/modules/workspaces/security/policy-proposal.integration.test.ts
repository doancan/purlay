/** Proposals and keyset previews reuse real facts without creating session/workspace authority. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import type { WorkspacePolicySettings } from '@purlay/types/workspace-security';
import {
  readWorkspacePolicyPreviewPage,
  type readWorkspaceAccessFacts,
} from '../../../platform/workspace-access-facts';
import { evaluateWorkspacePolicyProposal } from '../../../platform/workspace-access';
import { aSession } from '../../../testing/signed-in';
import { aUniqueSlug, aUserRow } from '../../../testing/users';
import { codeAt, keyOf } from '../../../testing/totp';
import { workspaceAccessStatus, workspacePolicyProposalStatus } from './access';
import { startWorkspaceMfaEnrollment, verifyWorkspaceMfa } from './mfa';
import { companyWorkspaceMfaActor, workspaceMfaFixture } from './mfa.testing';

afterAll(closeIntegrationDatabase);
const settings = (overrides: Partial<WorkspacePolicySettings> = {}): WorkspacePolicySettings => ({
  mode: 'enforced',
  signIn: 'any',
  allowedConnectionIds: [],
  requireMfa: false,
  idleMinutes: 15,
  maxAgeHours: 1,
  mfaMaxAgeMinutes: 5,
  ...overrides,
});
const inputFor = (
  f: Awaited<ReturnType<typeof workspaceMfaFixture>>,
): Parameters<typeof readWorkspaceAccessFacts>[1] => ({
  sessionId: f.actor.sessionId,
  userId: f.actor.context.userId,
  workspaceIds: [f.actor.context.workspaceId],
  now: f.dependencies.clock.now(),
  lifetime: f.dependencies.lifetime(),
});

describe('integration: read-only workspace policy proposals', () => {
  test('a proposal evaluates actual source/MFA choice without changing policy or assurance', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await workspaceAccessStatus(f.dependencies, f.actor);
      const before = await db
        .selectFrom('workspace_session_assurances')
        .selectAll()
        .where('session_id', '=', f.actor.sessionId)
        .execute();
      expect((await workspacePolicyProposalStatus(f.dependencies, f.actor, settings())).state).toBe(
        'allowed',
      );
      expect(
        (
          await workspacePolicyProposalStatus(
            f.dependencies,
            f.actor,
            settings({ requireMfa: true }),
          )
        ).state,
      ).toBe('mfa_enrollment_required');
      expect(
        (
          await workspacePolicyProposalStatus(
            f.dependencies,
            f.actor,
            settings({ signIn: 'company', allowedConnectionIds: [] }),
          )
        ).state,
      ).toBe('sign_in_required');
      expect(
        await db
          .selectFrom('workspace_session_assurances')
          .selectAll()
          .where('session_id', '=', f.actor.sessionId)
          .execute(),
      ).toEqual(before);
      expect(
        await db
          .selectFrom('workspace_access_policies')
          .selectAll()
          .where('workspace_id', '=', f.actor.context.workspaceId)
          .execute(),
      ).toEqual([]);
    });
  });
  test('actual accepted workspace MFA satisfies a proposal while expired MFA/base caps cannot be relaxed into fresh proof', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      const setup = await startWorkspaceMfaEnrollment(f.dependencies, f.actor, {
        policyRevision: null,
        factorRevision: null,
      });
      await verifyWorkspaceMfa(f.dependencies, f.actor, {
        challengeId: setup.challenge.challengeId,
        code: codeAt(keyOf(setup.totpURI), f.dependencies.clock.now().getTime()),
      });
      expect(
        (
          await workspacePolicyProposalStatus(
            f.dependencies,
            f.actor,
            settings({ requireMfa: true }),
          )
        ).state,
      ).toBe('allowed');
      const revision = crypto.randomUUID();
      await db
        .updateTable('workspaces')
        .set({ access_policy_epoch: '1' })
        .where('id', '=', f.actor.context.workspaceId)
        .execute();
      await db
        .insertInto('workspace_access_policies')
        .values({
          workspace_id: f.actor.context.workspaceId,
          epoch: '1',
          revision,
          mode: 'enforced',
          sign_in: 'any',
          require_mfa: true,
          idle_minutes: 15,
          max_age_hours: 1,
          mfa_max_age_minutes: 5,
        })
        .execute();
      f.move(5 * 60_000);
      const before = await db
        .selectFrom('workspace_session_assurances')
        .selectAll()
        .where('session_id', '=', f.actor.sessionId)
        .execute();
      expect(
        (
          await workspacePolicyProposalStatus(
            f.dependencies,
            f.actor,
            settings({ requireMfa: true, mfaMaxAgeMinutes: 30 }),
          )
        ).state,
      ).toBe('mfa_required');
      expect(
        (
          await workspacePolicyProposalStatus(
            f.dependencies,
            f.actor,
            settings({ mode: 'off', idleMinutes: null, maxAgeHours: null }),
          )
        ).expiresAt,
      ).toBe(new Date(f.dependencies.clock.now().getTime() + 10 * 60_000).toISOString());
      f.move(10 * 60_000);
      expect(
        (
          await workspacePolicyProposalStatus(
            f.dependencies,
            f.actor,
            settings({ mode: 'off', idleMinutes: null, maxAgeHours: null }),
          )
        ).state,
      ).toBe('expired');
      expect(
        await db
          .selectFrom('workspace_session_assurances')
          .selectAll()
          .where('session_id', '=', f.actor.sessionId)
          .execute(),
      ).toEqual(before);
    });
  });
  test('a newer actual captured native global event is projected without writing its workspace receipt', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await workspaceAccessStatus(f.dependencies, f.actor);
      const before = await db
        .selectFrom('workspace_session_assurances')
        .selectAll()
        .where('session_id', '=', f.actor.sessionId)
        .execute();
      const factor = await db
        .insertInto('two_factors')
        .values({
          id: crypto.randomUUID(),
          user_id: f.actor.context.userId,
          secret: 'opaque native factor fixture',
          backup_codes: 'opaque native recovery fixture',
          verified: true,
        })
        .returning(['id', 'assurance_revision'])
        .executeTakeFirstOrThrow();
      await db
        .updateTable('two_factors')
        .set({ last_assurance_counter: 42 })
        .where('id', '=', factor.id)
        .execute();
      await db
        .updateTable('session_authentication_evidence')
        .set({
          global_mfa_factor_id: factor.id,
          global_mfa_factor_revision: factor.assurance_revision,
          global_mfa_method: 'totp',
          global_mfa_counter: 42,
          global_mfa_verified_at: f.dependencies.clock.now(),
        })
        .where('session_id', '=', f.actor.sessionId)
        .execute();
      expect(
        (
          await workspacePolicyProposalStatus(
            f.dependencies,
            f.actor,
            settings({ requireMfa: true }),
          )
        ).state,
      ).toBe('allowed');
      expect(
        await db
          .selectFrom('workspace_session_assurances')
          .selectAll()
          .where('session_id', '=', f.actor.sessionId)
          .execute(),
      ).toEqual(before);
    });
  });
  test('a genuinely ended proof is never projected back into authority', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await workspaceAccessStatus(f.dependencies, f.actor);
      await db
        .updateTable('workspace_session_assurances')
        .set({ ended_at: f.dependencies.clock.now(), end_reason: 'factor_revoked' })
        .where('session_id', '=', f.actor.sessionId)
        .execute();
      expect(
        (await workspacePolicyProposalStatus(f.dependencies, f.actor, settings({ mode: 'off' })))
          .state,
      ).toBe('expired');
    });
  });
  test('bounded keyset pages include sessionless guests, exclude foreign-company candidates and never query global inventory for company rows', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await aSession(db, f.dependencies.clock, f.actor.context.userId);
      const company = await companyWorkspaceMfaActor(f.dependencies, f.actor);
      const outside = await db
        .insertInto('workspaces')
        .values({ name: 'Outside', slug: aUniqueSlug('outside-preview') })
        .returning('id')
        .executeTakeFirstOrThrow();
      const outsideSource = await aSession(db, f.dependencies.clock, f.actor.context.userId, 30, {
        companyWorkspaceId: outside.id,
      });
      const guest = await aUserRow(db, 'preview-sessionless');
      await db
        .insertInto('workspace_members')
        .values({
          workspace_id: f.actor.context.workspaceId,
          user_id: guest.userId,
          role: 'member',
          access_kind: 'guest',
          guest_since: new Date(f.dependencies.clock.now().getTime() - 60_000),
          guest_modules: ['chat'],
        })
        .execute();
      await db
        .insertInto('two_factors')
        .values({
          id: crypto.randomUUID(),
          user_id: f.actor.context.userId,
          secret: 'opaque native factor fixture',
          backup_codes: 'opaque recovery fixture',
          verified: true,
        })
        .execute();
      const enrolled = await startWorkspaceMfaEnrollment(f.dependencies, f.member, {
        policyRevision: null,
        factorRevision: null,
      });
      await verifyWorkspaceMfa(f.dependencies, f.member, {
        challengeId: enrolled.challenge.challengeId,
        code: codeAt(keyOf(enrolled.totpURI), f.dependencies.clock.now().getTime()),
      });
      const existingReceipts = await db
        .selectFrom('workspace_session_assurances')
        .selectAll()
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .execute();
      let reads = 0;
      const counted = db.withPlugin({
        transformQuery: (
          args,
        ): ReturnType<Parameters<Executor['withPlugin']>[0]['transformQuery']> => {
          if (args.node.kind === 'SelectQueryNode') reads++;
          return args.node;
        },
        transformResult: (args) => Promise.resolve(args.result),
      });
      const all: Awaited<ReturnType<typeof readWorkspacePolicyPreviewPage>>['rows'][number][] = [];
      let after: Awaited<ReturnType<typeof readWorkspacePolicyPreviewPage>>['next'] = null;
      do {
        reads = 0;
        const page = await readWorkspacePolicyPreviewPage(counted, {
          workspaceId: f.actor.context.workspaceId,
          now: f.dependencies.clock.now(),
          lifetime: f.dependencies.lifetime(),
          limit: 2,
          ...(after === null ? {} : { after }),
        });
        expect(reads).toBeLessThanOrEqual(8);
        all.push(...page.rows);
        after = page.next;
      } while (after !== null);
      expect(all).toHaveLength(5);
      expect(new Set(all.map((row) => `${row.userId}:${row.sessionId ?? 'none'}`)).size).toBe(5);
      expect(
        all.some(
          (row) =>
            row.userId === guest.userId && row.sessionId === null && row.accessKind === 'guest',
        ),
      ).toBe(true);
      expect(all.some((row) => row.sessionId === outsideSource.sessionId)).toBe(false);
      const companyRow = all.find((row) => row.sessionId === company.actor.sessionId);
      expect(companyRow?.facts.companyProof?.live).toBe(true);
      expect(companyRow?.facts.globalFactor).toBeUndefined();
      expect(
        all.some(
          (row) =>
            row.facts.session?.company_workspace_id === null &&
            row.facts.globalFactor !== undefined,
        ),
      ).toBe(true);
      for (const row of all) {
        const decision = evaluateWorkspacePolicyProposal(
          {
            ...inputFor(f),
            sessionId: row.sessionId ?? '00000000-0000-0000-0000-000000000000',
            userId: row.userId,
          },
          f.actor.context.workspaceId,
          row.facts,
          settings(),
        );
        expect(decision.allowed).toBe(
          row.facts.evidence?.method !== undefined && row.facts.evidence.method !== null,
        );
      }
      expect(
        await db
          .selectFrom('workspace_session_assurances')
          .selectAll()
          .where('workspace_id', '=', f.actor.context.workspaceId)
          .execute(),
      ).toEqual(existingReceipts);
    });
  });
  test('a page containing only a member without sessions and an empty page stay bounded/read-only', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await db
        .deleteFrom('sessions')
        .where('user_id', 'in', [f.actor.context.userId, f.member.context.userId])
        .execute();
      const page = await readWorkspacePolicyPreviewPage(db, {
        workspaceId: f.actor.context.workspaceId,
        now: f.dependencies.clock.now(),
        lifetime: f.dependencies.lifetime(),
        limit: 100,
      });
      expect(page.rows).toHaveLength(2);
      expect(page.rows.every((row) => row.sessionId === null)).toBe(true);
      expect(page.next).toBeNull();
      const empty = await readWorkspacePolicyPreviewPage(db, {
        workspaceId: crypto.randomUUID(),
        now: f.dependencies.clock.now(),
        lifetime: f.dependencies.lifetime(),
        limit: 100,
      });
      expect(empty.rows).toEqual([]);
      const invalid: unknown = await readWorkspacePolicyPreviewPage(db, {
        workspaceId: f.actor.context.workspaceId,
        now: f.dependencies.clock.now(),
        lifetime: f.dependencies.lifetime(),
        limit: 0,
      }).catch((error: unknown) => error);
      expect(invalid).toBeInstanceOf(Error);
    });
  });
});
