/** Connection revisions and sealed secrets cannot manufacture proof of provider authentication. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Transaction } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { eraseAccount } from '../../users/erasure';
import { chatUserErased } from '../../../features/chat/channels/user-hooks';
import {
  COMPANY_CONNECTIONS_MAX,
  CompanyIdentityConnection,
  type CompanyIdentityDomain,
} from '@purlay/types/workspace-identity';
import { companyIdentityFixture } from '../../../testing/company-identity';
import { attempt } from '../../../testing/attempt';
import { createCompanyDomain, revokeCompanyDomain, verifyCompanyDomain } from './domains';
import {
  createCompanyConnection,
  deleteCompanyConnection,
  listCompanyConnections,
  setCompanyConnectionEnabled,
  updateCompanyConnection,
} from './connections';

afterAll(closeIntegrationDatabase);

const setup = async (
  db: Transaction,
): Promise<
  Awaited<ReturnType<typeof companyIdentityFixture>> & {
    readonly domain: CompanyIdentityDomain;
  }
> => {
  const fixture = await companyIdentityFixture(db);
  const { dependencies, actor } = fixture;
  const pending = await createCompanyDomain(dependencies, actor, 'company.example');
  const domain = await verifyCompanyDomain(dependencies, actor, pending.id, pending.revision, () =>
    Promise.resolve([[pending.dnsRecord?.value ?? '']]),
  );
  return { ...fixture, domain };
};

const provider = (
  domainId: string,
): {
  readonly name: string;
  readonly domainId: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
} => ({
  name: 'Company Google',
  domainId,
  issuer: 'https://accounts.google.com',
  clientId: 'company-client',
  clientSecret: 'test-write-only-company-secret',
});

describe('integration: company provider configuration', () => {
  test('unverified domains cannot configure a provider; credentials remain sealed and write-only', async () => {
    await withRollback(async (db) => {
      const { dependencies, actor } = await companyIdentityFixture(db);
      const pending = await createCompanyDomain(dependencies, actor, 'company.example');
      expect(
        await attempt(
          db,
          async () => await createCompanyConnection(dependencies, actor, provider(pending.id)),
        ),
      ).toBe('COMPANY_IDENTITY_NOT_READY');
      await verifyCompanyDomain(dependencies, actor, pending.id, pending.revision, () =>
        Promise.resolve([[pending.dnsRecord?.value ?? '']]),
      );
      const input = provider(pending.id);
      const made = await createCompanyConnection(dependencies, actor, input);
      expect(Value.Check(CompanyIdentityConnection, made)).toBe(true);
      expect(made.enabled).toBe(false);
      expect(made.ready).toBe(false);
      expect(made.secretConfigured).toBe(true);
      expect(JSON.stringify(made)).not.toContain(input.clientSecret);
      expect(Object.keys(made)).not.toContain('clientSecret');
      const stored = await db
        .selectFrom('workspace_identity_connections')
        .select('client_secret_encrypted')
        .where('id', '=', made.id)
        .executeTakeFirstOrThrow();
      expect(stored.client_secret_encrypted).not.toBeNull();
      expect(
        await dependencies.cipher.open(stored.client_secret_encrypted ?? Buffer.alloc(0), made.id),
      ).toBe(input.clientSecret);
      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('target_id', '=', made.id)
        .execute();
      expect(JSON.stringify(audit)).not.toContain(input.clientSecret);
      expect((await listCompanyConnections(dependencies, actor)).data).toEqual([made]);
      expect(
        await attempt(
          db,
          async () =>
            await setCompanyConnectionEnabled(dependencies, actor, made.id, made.revision, true),
        ),
      ).toBe('COMPANY_IDENTITY_NOT_READY');
    });
  });

  test('a label edit preserves tested authentication and omitted secret; a credential edit disables and fences it', async () => {
    await withRollback(async (db) => {
      const { dependencies, actor, domain } = await setup(db);
      const made = await createCompanyConnection(dependencies, actor, provider(domain.id));
      const before = await db
        .selectFrom('workspace_identity_connections')
        .selectAll()
        .where('id', '=', made.id)
        .executeTakeFirstOrThrow();
      // Only a fixture certifies the test here; the production callback must prove it with the provider.
      await db
        .updateTable('workspace_identity_connections')
        .set({
          tested_authentication_revision: before.authentication_revision,
          tested_at: dependencies.clock.now(),
        })
        .where('id', '=', made.id)
        .execute();
      const enabled = await setCompanyConnectionEnabled(
        dependencies,
        actor,
        made.id,
        made.revision,
        true,
      );
      const renamed = await updateCompanyConnection(dependencies, actor, made.id, {
        revision: enabled.revision,
        name: 'Office sign-in',
      });
      expect(renamed.enabled).toBe(true);
      expect(renamed.ready).toBe(true);
      const afterName = await db
        .selectFrom('workspace_identity_connections')
        .selectAll()
        .where('id', '=', made.id)
        .executeTakeFirstOrThrow();
      expect(afterName.client_secret_encrypted).toEqual(before.client_secret_encrypted);
      expect(afterName.authentication_revision).toBe(before.authentication_revision);
      const changed = await updateCompanyConnection(dependencies, actor, made.id, {
        revision: renamed.revision,
        clientSecret: 'replacement-company-secret',
      });
      expect(changed.enabled).toBe(false);
      expect(changed.ready).toBe(false);
      expect(changed.testedAt).toBeNull();
      const stored = await db
        .selectFrom('workspace_identity_connections')
        .selectAll()
        .where('id', '=', made.id)
        .executeTakeFirstOrThrow();
      expect(stored.authentication_revision).not.toBe(before.authentication_revision);
      expect(
        await dependencies.cipher.open(stored.client_secret_encrypted ?? Buffer.alloc(0), made.id),
      ).toBe('replacement-company-secret');
      expect(
        await attempt(
          db,
          async () =>
            await setCompanyConnectionEnabled(dependencies, actor, made.id, changed.revision, true),
        ),
      ).toBe('COMPANY_IDENTITY_NOT_READY');
    });
  });

  test('stale edits, toggles and removal cannot overwrite a newer configuration', async () => {
    await withRollback(async (db) => {
      const { dependencies, actor, domain } = await setup(db);
      const made = await createCompanyConnection(dependencies, actor, provider(domain.id));
      const changed = await updateCompanyConnection(dependencies, actor, made.id, {
        revision: made.revision,
        clientId: 'changed-client',
      });
      expect(
        await attempt(
          db,
          async () =>
            await updateCompanyConnection(dependencies, actor, made.id, {
              revision: made.revision,
              name: 'stale-name',
            }),
        ),
      ).toBe('COMPANY_IDENTITY_CHANGED');
      expect(
        await attempt(
          db,
          async () =>
            await setCompanyConnectionEnabled(dependencies, actor, made.id, made.revision, false),
        ),
      ).toBe('COMPANY_IDENTITY_CHANGED');
      expect(
        await attempt(db, async () => {
          await deleteCompanyConnection(dependencies, actor, made.id, made.revision);
        }),
      ).toBe('COMPANY_IDENTITY_CHANGED');
      expect((await listCompanyConnections(dependencies, actor)).data).toEqual([changed]);
    });
  });

  test('exact bindings end with membership; unlink provenance does not disappear with the binding', async () => {
    await withRollback(async (db) => {
      const { dependencies, actor, member, domain } = await setup(db);
      const made = await createCompanyConnection(dependencies, actor, provider(domain.id));
      const connection = await db
        .selectFrom('workspace_identity_connections')
        .selectAll()
        .where('id', '=', made.id)
        .executeTakeFirstOrThrow();
      const binding = await db
        .insertInto('workspace_identity_bindings')
        .values({
          workspace_id: actor.context.workspaceId,
          connection_id: made.id,
          user_id: member.context.userId,
          issuer: made.issuer,
          subject: 'external-stable-subject',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('workspace_identity_sessions')
        .values({
          session_id: member.sessionId,
          workspace_id: actor.context.workspaceId,
          connection_id: made.id,
          binding_reference: binding.id,
          authentication_revision: connection.authentication_revision,
          authenticated_at: dependencies.clock.now(),
        })
        .execute();
      expect(
        await attempt(
          db,
          async () =>
            await updateCompanyConnection(dependencies, actor, made.id, {
              revision: made.revision,
              issuer: 'https://another-provider.example',
            }),
        ),
      ).toBe('COMPANY_IDENTITY_NOT_READY');
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', actor.context.workspaceId)
        .where('user_id', '=', member.context.userId)
        .execute();
      expect(
        await db
          .selectFrom('workspace_identity_bindings')
          .select('id')
          .where('id', '=', binding.id)
          .executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await db
          .selectFrom('workspace_identity_sessions')
          .select('binding_reference')
          .where('session_id', '=', member.sessionId)
          .executeTakeFirst(),
      ).toEqual({ binding_reference: binding.id });
      await db
        .insertInto('workspace_members')
        .values({
          workspace_id: actor.context.workspaceId,
          user_id: member.context.userId,
          role: 'member',
        })
        .execute();
      expect(
        await db
          .selectFrom('workspace_identity_bindings')
          .select('id')
          .where('user_id', '=', member.context.userId)
          .execute(),
      ).toEqual([]);
      await db.deleteFrom('sessions').where('id', '=', member.sessionId).execute();
      expect(
        await db
          .selectFrom('workspace_identity_sessions')
          .select('session_id')
          .where('session_id', '=', member.sessionId)
          .execute(),
      ).toEqual([]);
    });
  });

  test('account erasure removes external bindings and session proofs while company configuration stays', async () => {
    await withRollback(async (db) => {
      const { dependencies, actor, member, domain } = await setup(db);
      const made = await createCompanyConnection(dependencies, actor, provider(domain.id));
      const connection = await db
        .selectFrom('workspace_identity_connections')
        .selectAll()
        .where('id', '=', made.id)
        .executeTakeFirstOrThrow();
      const binding = await db
        .insertInto('workspace_identity_bindings')
        .values({
          workspace_id: actor.context.workspaceId,
          connection_id: made.id,
          user_id: member.context.userId,
          issuer: made.issuer,
          subject: 'erase-external-subject',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('workspace_identity_sessions')
        .values({
          session_id: member.sessionId,
          workspace_id: actor.context.workspaceId,
          connection_id: made.id,
          binding_reference: binding.id,
          authentication_revision: connection.authentication_revision,
          authenticated_at: dependencies.clock.now(),
        })
        .execute();
      const person = await db
        .selectFrom('users')
        .select('username')
        .where('id', '=', member.context.userId)
        .executeTakeFirstOrThrow();
      await eraseAccount(
        db,
        dependencies.clock,
        { userId: member.context.userId, sessionId: member.sessionId },
        person.username,
        chatUserErased(),
      );
      expect(
        await db
          .selectFrom('workspace_identity_bindings')
          .select('id')
          .where('user_id', '=', member.context.userId)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('workspace_identity_sessions')
          .select('session_id')
          .where('session_id', '=', member.sessionId)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('workspace_members')
          .select('user_id')
          .where('workspace_id', '=', actor.context.workspaceId)
          .where('user_id', '=', member.context.userId)
          .executeTakeFirst(),
      ).toEqual({ user_id: member.context.userId });
      expect((await listCompanyConnections(dependencies, actor)).data[0]?.id).toBe(made.id);
    });
  });

  test('domain revocation disables its connections; re-adding the same DNS name restores no old authority', async () => {
    await withRollback(async (db) => {
      const { dependencies, actor, domain } = await setup(db);
      const made = await createCompanyConnection(dependencies, actor, provider(domain.id));
      const before = await db
        .selectFrom('workspace_identity_connections')
        .select('authentication_revision')
        .where('id', '=', made.id)
        .executeTakeFirstOrThrow();
      await db
        .updateTable('workspace_identity_connections')
        .set({
          tested_authentication_revision: before.authentication_revision,
          tested_at: dependencies.clock.now(),
          enabled: true,
        })
        .where('id', '=', made.id)
        .execute();
      await revokeCompanyDomain(dependencies, actor, domain.id, domain.revision);
      const connections = (await listCompanyConnections(dependencies, actor)).data;
      expect(connections[0]?.enabled).toBe(false);
      expect(connections[0]?.ready).toBe(false);
      const newDomain = await createCompanyDomain(dependencies, actor, domain.domain);
      expect(newDomain.id).not.toBe(domain.id);
      expect(connections[0]?.domainId).toBe(domain.id);
      expect(
        await attempt(
          db,
          async () =>
            await setCompanyConnectionEnabled(
              dependencies,
              actor,
              made.id,
              connections[0]?.revision ?? '',
              true,
            ),
        ),
      ).toBe('COMPANY_IDENTITY_NOT_READY');
    });
  });

  test('removal clears credentials; the retired row cannot be edited, enabled or included in lists', async () => {
    await withRollback(async (db) => {
      const { dependencies, actor, domain } = await setup(db);
      const made = await createCompanyConnection(dependencies, actor, provider(domain.id));
      await deleteCompanyConnection(dependencies, actor, made.id, made.revision);
      await deleteCompanyConnection(dependencies, actor, made.id, made.revision);
      expect((await listCompanyConnections(dependencies, actor)).data).toEqual([]);
      const retired = await db
        .selectFrom('workspace_identity_connections')
        .selectAll()
        .where('id', '=', made.id)
        .executeTakeFirstOrThrow();
      expect(retired.client_secret_encrypted).toBeNull();
      expect(retired.enabled).toBe(false);
      expect(
        await attempt(
          db,
          async () =>
            await updateCompanyConnection(dependencies, actor, made.id, {
              revision: retired.revision,
              name: 'revived',
            }),
        ),
      ).toBe('COMPANY_IDENTITY_NOT_FOUND');
      expect(
        await attempt(
          db,
          async () =>
            await setCompanyConnectionEnabled(dependencies, actor, made.id, retired.revision, true),
        ),
      ).toBe('COMPANY_IDENTITY_NOT_FOUND');
      expect((await createCompanyConnection(dependencies, actor, provider(domain.id))).id).not.toBe(
        made.id,
      );
    });
  });

  test('connection inventory and URL refusal are bounded without contacting the issuer', async () => {
    await withRollback(async (db) => {
      const { dependencies, actor, domain } = await setup(db);
      for (const issuer of [
        'http://accounts.google.com',
        'https://127.0.0.1',
        'https://[::1]',
        'https://idp.localhost',
        'https://a:b@idp.example',
        'https://idp.example?token=secret',
      ])
        expect(
          await attempt(
            db,
            async () =>
              await createCompanyConnection(dependencies, actor, {
                ...provider(domain.id),
                issuer,
              }),
          ),
        ).toBe('VALIDATION_FAILED');
      for (let index = 0; index < COMPANY_CONNECTIONS_MAX; index++)
        await createCompanyConnection(dependencies, actor, {
          ...provider(domain.id),
          name: `Company ${String(index)}`,
        });
      expect((await listCompanyConnections(dependencies, actor)).data).toHaveLength(
        COMPANY_CONNECTIONS_MAX,
      );
      expect(
        await attempt(
          db,
          async () => await createCompanyConnection(dependencies, actor, provider(domain.id)),
        ),
      ).toBe('COMPANY_IDENTITY_LIMIT');
    });
  });
});
