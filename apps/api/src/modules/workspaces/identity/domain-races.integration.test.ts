/** Independent committed transactions prove that DNS does not hold authority locks or consume replacements. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  withRollback,
  type ClonedDatabase,
} from '@purlay/db';
import { AppError } from '../../../platform/errors';
import { companyIdentityFixture } from '../../../testing/company-identity';
import { attempt } from '../../../testing/attempt';
import {
  createCompanyDomain,
  listCompanyDomains,
  renewCompanyDomain,
  verifyCompanyDomain,
} from './domains';
import { createCompanyConnection, updateCompanyConnection } from './connections';

let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

describe('integration: company identity SQL boundaries', () => {
  test('a separate transaction can replace the challenge while DNS waits; the late answer cannot consume it', async () => {
    const { dependencies, actor } = await companyIdentityFixture(clone.db);
    const made = await createCompanyDomain(dependencies, actor, 'company.example');
    const entered = Promise.withResolvers<undefined>();
    const finish = Promise.withResolvers<undefined>();
    const verification = verifyCompanyDomain(
      dependencies,
      actor,
      made.id,
      made.revision,
      async () => {
        entered.resolve(undefined);
        await finish.promise;
        return [[made.dnsRecord?.value ?? '']];
      },
    ).then(
      () => 'unexpected success',
      (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
    );
    await entered.promise;
    try {
      const renewed = await clone.db.transaction().execute(async (transaction) => {
        await sql`set local lock_timeout = '500ms'`.execute(transaction);
        return await renewCompanyDomain(
          { ...dependencies, database: transaction },
          actor,
          made.id,
          made.revision,
        );
      });
      finish.resolve(undefined);
      expect(await verification).toBe('COMPANY_IDENTITY_CHANGED');
      const current = (await listCompanyDomains(dependencies, actor)).data[0];
      expect(current).toEqual(renewed);
      expect(current?.dnsRecord?.value).not.toBe(made.dnsRecord?.value);
      expect(current?.state).toBe('pending');
    } finally {
      finish.resolve(undefined);
      await verification;
    }
  });

  for (const change of ['role', 'session', 'membership'] as const) {
    test(`committed ${change} revocation while DNS waits prevents verification`, async () => {
      const { dependencies, actor } = await companyIdentityFixture(clone.db);
      const made = await createCompanyDomain(dependencies, actor, 'company.example');
      const entered = Promise.withResolvers<undefined>();
      const finish = Promise.withResolvers<undefined>();
      const verification = verifyCompanyDomain(
        dependencies,
        actor,
        made.id,
        made.revision,
        async () => {
          entered.resolve(undefined);
          await finish.promise;
          return [[made.dnsRecord?.value ?? '']];
        },
      ).then(
        () => 'unexpected success',
        (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
      );
      await entered.promise;
      try {
        await clone.db.transaction().execute(async (transaction) => {
          await sql`set local lock_timeout = '500ms'`.execute(transaction);
          if (change === 'role')
            await transaction
              .updateTable('workspace_members')
              .set({ role: 'member' })
              .where('workspace_id', '=', actor.context.workspaceId)
              .where('user_id', '=', actor.context.userId)
              .execute();
          if (change === 'session')
            await transaction.deleteFrom('sessions').where('id', '=', actor.sessionId).execute();
          if (change === 'membership')
            await transaction
              .deleteFrom('workspace_members')
              .where('workspace_id', '=', actor.context.workspaceId)
              .where('user_id', '=', actor.context.userId)
              .execute();
        });
        finish.resolve(undefined);
        expect(await verification).toBe(
          change === 'role'
            ? 'FORBIDDEN'
            : change === 'session'
              ? 'UNAUTHENTICATED'
              : 'WORKSPACE_NOT_FOUND',
        );
        const row = await clone.db
          .selectFrom('workspace_identity_domains')
          .select(['revision', 'verified_at', 'challenge_digest'])
          .where('id', '=', made.id)
          .executeTakeFirstOrThrow();
        expect(row.revision).toBe(made.revision);
        expect(row.verified_at).toBeNull();
        expect(row.challenge_digest).not.toBeNull();
      } finally {
        finish.resolve(undefined);
        await verification;
      }
    });
  }

  test('an actual audit insert failure rolls back both domain creation and a provider credential change', async () => {
    await withRollback(async (db) => {
      const { dependencies, actor } = await companyIdentityFixture(db);
      await sql`create function identity_audit_fault() returns trigger language plpgsql as $$
        begin
          if current_setting('purlay.test_identity_audit_fault', true) = 'on'
             and new.action like 'identity.%' then
            raise exception 'reached identity audit insert failure';
          end if;
          return new;
        end;
      $$`.execute(db);
      await sql`create trigger identity_audit_fault before insert on audit_log
        for each row execute function identity_audit_fault()`.execute(db);
      await sql`set local purlay.test_identity_audit_fault = 'on'`.execute(db);
      expect(
        await attempt(
          db,
          async () => await createCompanyDomain(dependencies, actor, 'failed.example'),
        ),
      ).toContain('reached identity audit insert failure');
      expect((await listCompanyDomains(dependencies, actor)).data).toEqual([]);
      await sql`set local purlay.test_identity_audit_fault = 'off'`.execute(db);
      const pending = await createCompanyDomain(dependencies, actor, 'company.example');
      await verifyCompanyDomain(dependencies, actor, pending.id, pending.revision, () =>
        Promise.resolve([[pending.dnsRecord?.value ?? '']]),
      );
      const made = await createCompanyConnection(dependencies, actor, {
        domainId: pending.id,
        name: 'Office',
        issuer: 'https://idp.example',
        clientId: 'office',
        clientSecret: 'original-secret',
      });
      const before = await db
        .selectFrom('workspace_identity_connections')
        .selectAll()
        .where('id', '=', made.id)
        .executeTakeFirstOrThrow();
      await sql`set local purlay.test_identity_audit_fault = 'on'`.execute(db);
      expect(
        await attempt(
          db,
          async () =>
            await updateCompanyConnection(dependencies, actor, made.id, {
              revision: made.revision,
              clientSecret: 'uncommitted-secret',
            }),
        ),
      ).toContain('reached identity audit insert failure');
      expect(
        await db
          .selectFrom('workspace_identity_connections')
          .selectAll()
          .where('id', '=', made.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
    }, clone.db);
  });
});
