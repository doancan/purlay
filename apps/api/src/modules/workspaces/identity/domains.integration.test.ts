/** Domain ownership comes from the current exact DNS proof and live native authority. */
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { Resolver } from 'node:dns/promises';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import {
  COMPANY_DOMAINS_MAX,
  COMPANY_DOMAIN_CHALLENGE_SECONDS,
} from '@purlay/types/workspace-identity';
import { attempt } from '../../../testing/attempt';
import { tokenDigest } from '../../../platform/tokens';
import { companyIdentityFixture } from '../../../testing/company-identity';
import {
  createCompanyDomain,
  listCompanyDomains,
  lookupCompanyTxt,
  renewCompanyDomain,
  revokeCompanyDomain,
  verifyCompanyDomain,
} from './domains';

afterAll(closeIntegrationDatabase);

describe('integration: company DNS ownership', () => {
  test('the production DNS adapter verifies an answer and translates resolver failures without consuming proof', async () => {
    const dns = spyOn(Resolver.prototype, 'resolveTxt');
    try {
      await withRollback(async (db) => {
        const { dependencies, actor } = await companyIdentityFixture(db);
        const pending = await createCompanyDomain(dependencies, actor, 'resolver.example');
        dns.mockResolvedValue([[pending.dnsRecord?.value ?? '']]);
        expect(
          (
            await verifyCompanyDomain(
              dependencies,
              actor,
              pending.id,
              pending.revision,
              lookupCompanyTxt,
            )
          ).state,
        ).toBe('verified');
        expect(dns.mock.calls).toEqual([['_purlay-verification.resolver.example']]);
        const failing = await createCompanyDomain(dependencies, actor, 'failed-resolver.example');
        dns.mockRejectedValue(new Error('external DNS unavailable'));
        expect(
          await attempt(
            db,
            async () =>
              await verifyCompanyDomain(
                dependencies,
                actor,
                failing.id,
                failing.revision,
                lookupCompanyTxt,
              ),
          ),
        ).toBe('COMPANY_IDENTITY_NOT_READY');
        for (const records of [Array.from({ length: 65 }, () => ['x']), [['x'.repeat(4_097)]]]) {
          expect(
            await attempt(
              db,
              async () =>
                await verifyCompanyDomain(dependencies, actor, failing.id, failing.revision, () =>
                  Promise.resolve(records),
                ),
            ),
          ).toBe('COMPANY_IDENTITY_NOT_READY');
        }
        expect(
          (await listCompanyDomains(dependencies, actor)).data.find(
            (entry) => entry.id === failing.id,
          )?.revision,
        ).toBe(failing.revision);
      });
    } finally {
      dns.mockRestore();
    }
  });

  test('a stalled external DNS lookup is cancelled by the production five-second bound', async () => {
    const reply = Promise.withResolvers<string[][]>();
    const dns = spyOn(Resolver.prototype, 'resolveTxt').mockImplementation(() => reply.promise);
    const cancel = spyOn(Resolver.prototype, 'cancel').mockImplementation(() => {
      reply.reject(new Error('DNS cancelled'));
    });
    try {
      const failure = await lookupCompanyTxt('_purlay-verification.timeout.example').then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(cancel.mock.calls).toHaveLength(1);
    } finally {
      dns.mockRestore();
      cancel.mockRestore();
    }
  }, 8_000);

  test('canonical creation is idempotent; reload reopens only the intentional DNS proof', async () => {
    await withRollback(async (db) => {
      const { dependencies, actor } = await companyIdentityFixture(db);
      const made = await createCompanyDomain(dependencies, actor, ' BÜCHER.Example. ');
      expect(made.domain).toBe('xn--bcher-kva.example');
      expect(made.state).toBe('pending');
      expect(made.dnsRecord?.name).toBe('_purlay-verification.xn--bcher-kva.example');
      expect(made.dnsRecord?.value).toMatch(/^purlay-verification=[0-9a-f]{64}$/);
      expect(await createCompanyDomain(dependencies, actor, made.domain)).toEqual(made);
      expect((await listCompanyDomains(dependencies, actor)).data).toEqual([made]);
      const stored = await db
        .selectFrom('workspace_identity_domains')
        .selectAll()
        .where('id', '=', made.id)
        .executeTakeFirstOrThrow();
      expect(stored.challenge_digest).toBe(await tokenDigest(made.dnsRecord?.value ?? ''));
      expect(Buffer.from(stored.challenge_encrypted ?? []).toString()).not.toContain(
        made.dnsRecord?.value ?? 'missing',
      );
      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('target_id', '=', made.id)
        .execute();
      expect(audit.map((row) => row.action)).toEqual(['identity.domain_created']);
      expect(JSON.stringify(audit)).not.toContain(made.dnsRecord?.value ?? 'missing');
    });
  });

  test('TXT chunks concatenate within one record, never across different records', async () => {
    await withRollback(async (db) => {
      const { dependencies, actor } = await companyIdentityFixture(db);
      const made = await createCompanyDomain(dependencies, actor, 'company.example');
      const value = made.dnsRecord?.value ?? '';
      expect(
        await attempt(
          db,
          async () =>
            await verifyCompanyDomain(dependencies, actor, made.id, made.revision, () =>
              Promise.resolve([[value.slice(0, 22)], [value.slice(22)]]),
            ),
        ),
      ).toBe('COMPANY_IDENTITY_NOT_READY');
      const verified = await verifyCompanyDomain(dependencies, actor, made.id, made.revision, () =>
        Promise.resolve([['unrelated=proof'], [value.slice(0, 22), value.slice(22)]]),
      );
      expect(verified.state).toBe('verified');
      expect(verified.dnsRecord).toBeNull();
      expect(verified.revision).not.toBe(made.revision);
      const stored = await db
        .selectFrom('workspace_identity_domains')
        .select(['challenge_digest', 'challenge_encrypted'])
        .where('id', '=', made.id)
        .executeTakeFirstOrThrow();
      expect(stored).toEqual({ challenge_digest: null, challenge_encrypted: null });
      expect(
        await verifyCompanyDomain(dependencies, actor, made.id, verified.revision, () => {
          throw new Error('Verified domains do not need another DNS call');
        }),
      ).toEqual(verified);
    });
  });

  test('an in-flight DNS result cannot verify a replacement challenge', async () => {
    await withRollback(async (db) => {
      const { dependencies, actor } = await companyIdentityFixture(db);
      const made = await createCompanyDomain(dependencies, actor, 'company.example');
      let replacementRevision = '';
      expect(
        await attempt(
          db,
          async () =>
            await verifyCompanyDomain(dependencies, actor, made.id, made.revision, async () => {
              const replacement = await renewCompanyDomain(
                dependencies,
                actor,
                made.id,
                made.revision,
              );
              replacementRevision = replacement.revision;
              expect(replacement.dnsRecord?.value).not.toBe(made.dnsRecord?.value);
              return await Promise.resolve([[made.dnsRecord?.value ?? '']]);
            }),
        ),
      ).toBe('COMPANY_IDENTITY_CHANGED');
      expect(replacementRevision).not.toBe(made.revision);
      // The enclosing savepoint rolls back the deliberately concurrent replacement too.
      expect((await listCompanyDomains(dependencies, actor)).data[0]?.state).toBe('pending');
    });
  });

  test('expiry is checked before and after DNS at the exact boundary', async () => {
    await withRollback(async (db) => {
      const { dependencies, actor, move } = await companyIdentityFixture(db);
      const made = await createCompanyDomain(dependencies, actor, 'company.example');
      expect(
        await attempt(
          db,
          async () =>
            await verifyCompanyDomain(dependencies, actor, made.id, made.revision, () => {
              move(COMPANY_DOMAIN_CHALLENGE_SECONDS * 1_000);
              return Promise.resolve([[made.dnsRecord?.value ?? '']]);
            }),
        ),
      ).toBe('COMPANY_IDENTITY_NOT_READY');
      const expired = (await listCompanyDomains(dependencies, actor)).data[0];
      expect(expired?.state).toBe('expired');
      expect(expired?.dnsRecord).toBeNull();
      let calls = 0;
      expect(
        await attempt(
          db,
          async () =>
            await verifyCompanyDomain(dependencies, actor, made.id, made.revision, () => {
              calls++;
              return Promise.resolve([]);
            }),
        ),
      ).toBe('COMPANY_IDENTITY_NOT_READY');
      expect(calls).toBe(0);
      expect((await renewCompanyDomain(dependencies, actor, made.id, made.revision)).state).toBe(
        'pending',
      );
    });
  });

  for (const change of ['role', 'membership', 'session', 'suspension', 'admission'] as const) {
    test(`fresh ${change} authority is required after DNS`, async () => {
      await withRollback(async (db) => {
        const { dependencies, actor } = await companyIdentityFixture(db);
        const made = await createCompanyDomain(dependencies, actor, 'company.example');
        const result = await attempt(
          db,
          async () =>
            await verifyCompanyDomain(dependencies, actor, made.id, made.revision, async () => {
              if (change === 'role')
                await db
                  .updateTable('workspace_members')
                  .set({ role: 'member' })
                  .where('workspace_id', '=', actor.context.workspaceId)
                  .where('user_id', '=', actor.context.userId)
                  .execute();
              if (change === 'membership')
                await db
                  .deleteFrom('workspace_members')
                  .where('workspace_id', '=', actor.context.workspaceId)
                  .where('user_id', '=', actor.context.userId)
                  .execute();
              if (change === 'session')
                await db.deleteFrom('sessions').where('id', '=', actor.sessionId).execute();
              if (change === 'suspension')
                await db
                  .updateTable('users')
                  .set({ suspended_at: dependencies.clock.now() })
                  .where('id', '=', actor.context.userId)
                  .execute();
              if (change === 'admission')
                await db
                  .updateTable('users')
                  .set({ admission_state: 'denied' })
                  .where('id', '=', actor.context.userId)
                  .execute();
              return await Promise.resolve([[made.dnsRecord?.value ?? '']]);
            }),
        );
        expect(result).toBe(
          change === 'role'
            ? 'FORBIDDEN'
            : change === 'membership'
              ? 'WORKSPACE_NOT_FOUND'
              : 'UNAUTHENTICATED',
        );
        expect((await listCompanyDomains(dependencies, actor)).data[0]?.state).toBe('pending');
      });
    });
  }

  test('the catalogue is bounded; an existing name still works at the cap', async () => {
    await withRollback(async (db) => {
      const { dependencies, actor } = await companyIdentityFixture(db);
      const first = await createCompanyDomain(dependencies, actor, 'company0.example');
      for (let index = 1; index < COMPANY_DOMAINS_MAX; index++)
        await createCompanyDomain(dependencies, actor, `company${String(index)}.example`);
      expect((await listCompanyDomains(dependencies, actor)).data).toHaveLength(
        COMPANY_DOMAINS_MAX,
      );
      expect(await createCompanyDomain(dependencies, actor, first.domain)).toEqual(first);
      expect(
        await attempt(
          db,
          async () => await createCompanyDomain(dependencies, actor, 'overflow.example'),
        ),
      ).toBe('COMPANY_IDENTITY_LIMIT');
      await revokeCompanyDomain(dependencies, actor, first.id, first.revision);
      expect((await createCompanyDomain(dependencies, actor, first.domain)).id).not.toBe(first.id);
    });
  });

  test('another workspace, a regular member and another person’s session confer no authority', async () => {
    await withRollback(async (db) => {
      const { dependencies, actor, member } = await companyIdentityFixture(db);
      const other = await companyIdentityFixture(db);
      const made = await createCompanyDomain(dependencies, actor, 'company.example');
      expect(
        await attempt(
          db,
          async () =>
            await renewCompanyDomain(other.dependencies, other.actor, made.id, made.revision),
        ),
      ).toBe('COMPANY_IDENTITY_NOT_FOUND');
      expect(await attempt(db, async () => await listCompanyDomains(dependencies, member))).toBe(
        'FORBIDDEN',
      );
      expect(
        await attempt(
          db,
          async () =>
            await listCompanyDomains(dependencies, {
              context: actor.context,
              sessionId: member.sessionId,
            }),
        ),
      ).toBe('UNAUTHENTICATED');
      for (const domain of [
        'https://company.example',
        '127.0.0.1',
        '*.company.example',
        'company.example:8443',
      ])
        expect(
          await attempt(db, async () => await createCompanyDomain(dependencies, actor, domain)),
        ).toBe('VALIDATION_FAILED');
    });
  });
});
