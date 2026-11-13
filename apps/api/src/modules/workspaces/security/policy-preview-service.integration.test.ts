/** Complete per-person impact counts stream batched session facts; tenfold growth adds pages, never per-user queries. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { companyWorkspaceMfaActor } from './mfa.testing';
import { createWorkspacePolicyRecovery, previewWorkspacePolicy } from './policy';
import { enforcedPolicy, workspacePolicyFixture } from './policy.testing';

afterAll(closeIntegrationDatabase);

describe('integration: bounded policy impact preview', () => {
  test('tenfold membership growth retains exact counts, keyset examples and batched query growth', async () => {
    const measurements: { size: number; queries: number }[] = [];
    for (const size of [12, 120])
      await withRollback(async (db) => {
        const f = await workspacePolicyFixture(db);
        await createWorkspacePolicyRecovery(f.dependencies, f.actor, { policyRevision: null });
        const company = await companyWorkspaceMfaActor(f.dependencies, f.actor);
        const people = Array.from({ length: size + 3 }, (_, index) => ({
          id: crypto.randomUUID(),
          index,
        }));
        await db
          .insertInto('users')
          .values(
            people.map((person) => ({
              id: person.id,
              username: person.id,
              email: `${person.id}@preview.test`,
              display_name: `Preview ${String(person.index)}`,
            })),
          )
          .execute();
        await db
          .insertInto('workspace_members')
          .values(
            people.map((person) => ({
              workspace_id: f.actor.context.workspaceId,
              user_id: person.id,
              ...(person.index >= size && person.index < size + 2
                ? {
                    access_kind: 'guest',
                    guest_since: f.dependencies.clock.now(),
                    guest_expires_at: new Date('2027-01-01T00:00:00Z'),
                    guest_modules: ['chat'],
                  }
                : {}),
            })),
          )
          .execute();
        const sessions = people
          .filter((person) => person.index < size + 2)
          .map((person) => ({ id: crypto.randomUUID(), user: person.id }));
        await db
          .insertInto('sessions')
          .values(
            sessions.map((session) => ({
              id: session.id,
              user_id: session.user,
              token_hash: crypto.randomUUID(),
              created_at: f.dependencies.clock.now(),
              last_used_at: f.dependencies.clock.now(),
              expires_at: new Date('2027-01-01T00:00:00Z'),
            })),
          )
          .execute();
        await db
          .insertInto('session_authentication_evidence')
          .values(
            sessions.map((session) => ({
              session_id: session.id,
              user_id: session.user,
              method: 'password',
              authenticated_at: f.dependencies.clock.now(),
            })),
          )
          .execute();
        const queries = { count: 0 };
        const counted = db.withPlugin({
          transformQuery(args) {
            queries.count += 1;
            return args.node;
          },
          transformResult(args) {
            return Promise.resolve(args.result);
          },
        });
        const settings = enforcedPolicy({
          signIn: 'company',
          allowedConnectionIds: [company.connectionId],
        });
        const started = performance.now();
        const preview = await previewWorkspacePolicy(
          { ...f.dependencies, database: counted },
          f.actor,
          { revision: null, policy: settings, limit: 2 },
        );
        const elapsed = performance.now() - started;
        const queryCount = queries.count;
        expect(preview.memberCount).toBe(size + 3);
        expect(preview.guestCount).toBe(2);
        expect(preview.affectedMemberCount).toBe(size + 3);
        expect(preview.affectedGuestCount).toBe(0);
        expect(preview.affectedSessionCount).toBe(size + 2);
        expect(preview.ownerRecoveryReady).toBe(true);
        expect(preview.examples.data).toHaveLength(2);
        expect(preview.examples.nextCursor).not.toBeNull();
        const next = await previewWorkspacePolicy(f.dependencies, f.actor, {
          revision: null,
          policy: settings,
          ...(preview.examples.nextCursor === null ? {} : { before: preview.examples.nextCursor }),
          limit: 2,
        });
        expect(
          next.examples.data.every(
            (person) => !preview.examples.data.some((first) => first.userId === person.userId),
          ),
        ).toBe(true);
        const mfa = await previewWorkspacePolicy(f.dependencies, f.actor, {
          revision: null,
          policy: { ...settings, requireMfa: true, mfaMaxAgeMinutes: 5 },
          limit: 2,
        });
        expect(mfa.affectedGuestCount).toBe(2);
        expect(mfa.affectedSessionCount).toBe(size + 5);
        measurements.push({ size, queries: queryCount });
        console.info(
          JSON.stringify({
            policyPreviewMeasurement: {
              members: size + 5,
              nativeSessions: size + 5,
              queryCount,
              elapsedMs: elapsed,
            },
          }),
        );
      });
    expect(measurements).toHaveLength(2);
    expect(
      (measurements[1]?.queries ?? Infinity) - (measurements[0]?.queries ?? 0),
    ).toBeLessThanOrEqual(8);
  });
});
