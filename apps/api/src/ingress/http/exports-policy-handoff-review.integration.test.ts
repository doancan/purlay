/** Archive bytes follow both live native sources after store I/O and each asynchronous stream pull. */
import { describe, afterAll, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { messageId } from '@purlay/types';
import { recordPrimaryAuthentication } from '../../modules/auth/authentication-evidence';
import { SESSION_COOKIE } from '../../platform/cookies';
import { withoutRequest } from '../../platform/logging';
import type { ObjectStore } from '../../platform/storage';
import {
  aDatabaseThatMustNotBeTouched,
  aMovableClock,
  testDependencies,
} from '../../testing/doubles';
import { aSession, aTestAuth } from '../../testing/signed-in';
import { aMemoryStore } from '../../testing/storage';
import { aUniqueSlug, aUserRow } from '../../testing/users';
import { archiveDownloadHandoff } from '../../modules/export/download-handoff';
import { companyWorkspaceMfaActor } from '../../modules/workspaces/security/mfa.testing';
import { workspaceAccessStatus } from '../../modules/workspaces/security/access';
import { NO_SESSION_LIFETIME } from '../../modules/auth/session-lifetime';
import { requireWorkspaceSecurityMembership } from '../../platform/tenancy';
import { credentialCipher } from '../../platform/crypto';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../../platform/config';
import { createApp } from './app';

describe('integration: archive policy handoff', () => {
  afterAll(closeIntegrationDatabase);

  test('archive handoffs recheck caller, original source, owner and exact prepared set before releasing bytes', async () => {
    const missingCaller = archiveDownloadHandoff({
      kind: 'personal',
      exportId: crypto.randomUUID(),
      key: 'unclaimed',
      userId: crypto.randomUUID(),
      callerSessionId: null,
      sourceSessionId: null,
      workspaceIds: [],
    });
    expect(
      await missingCaller({
        database: aDatabaseThatMustNotBeTouched(),
        clock: aMovableClock(),
      }).catch((error: unknown) => error),
    ).toMatchObject({ body: { code: 'UNAUTHENTICATED' } });
    const observed: {
      kind: string;
      stage: string;
      change: string;
      status: number;
      bodyFailed: boolean;
      contentReleased: boolean;
      cleaned: boolean;
    }[] = [];
    for (const kind of ['workspace', 'personal'] as const) {
      for (const stage of ['store', 'stream'] as const) {
        for (const change of [
          'none',
          'policy',
          'caller',
          'original',
          'scope',
          'owner',
          'deleted_original',
          'company_original',
          'caller_proof',
          'original_proof',
        ] as const) {
          if (
            stage === 'stream' &&
            (change === 'none' ||
              change === 'scope' ||
              change === 'deleted_original' ||
              change === 'company_original')
          )
            continue;
          if (
            (kind === 'personal' && change === 'owner') ||
            (kind === 'workspace' && change === 'company_original')
          )
            continue;
          await withoutRequest(async () => {
            await withRollback(async (db) => {
              const clock = aMovableClock(new Date());
              const user = await aUserRow(db, 'archive-handoff-owner');
              const workspace = await db
                .insertInto('workspaces')
                .values({ name: 'Archive handoff', slug: aUniqueSlug('archive-handoff') })
                .returning('id')
                .executeTakeFirstOrThrow();
              await db
                .insertInto('workspace_members')
                .values({ workspace_id: workspace.id, user_id: user.userId, role: 'owner' })
                .execute();
              const caller = await aSession(db, clock, user.userId);
              const original = await aSession(db, clock, user.userId);
              for (const session of [caller, original])
                await recordPrimaryAuthentication(db, session.sessionId, user.userId, {
                  method: 'password',
                  authenticatedAt: clock.now(),
                });
              await db
                .updateTable('workspaces')
                .set({ access_policy_epoch: '1' })
                .where('id', '=', workspace.id)
                .execute();
              await db
                .insertInto('workspace_access_policies')
                .values({
                  workspace_id: workspace.id,
                  epoch: '1',
                  mode: 'enforced',
                  sign_in: 'any',
                  require_mfa: false,
                })
                .execute();
              let originalSourceId = original.sessionId;
              if (change === 'company_original') {
                const context = await requireWorkspaceSecurityMembership(
                  db,
                  user.userId,
                  workspace.id,
                );
                const dependencies = {
                  database: db,
                  clock,
                  cipher: credentialCipher(DEVELOPMENT_ENCRYPTION_KEY),
                  lifetime: (): typeof NO_SESSION_LIFETIME => NO_SESSION_LIFETIME,
                };
                const company = await companyWorkspaceMfaActor(dependencies, {
                  context,
                  sessionId: original.sessionId,
                });
                originalSourceId = company.actor.sessionId;
                expect((await workspaceAccessStatus(dependencies, company.actor)).state).toBe(
                  'allowed',
                );
              }
              const archiveId = messageId(clock.now());
              const key = `review-archive/${archiveId}.tar`;
              const bytes = new TextEncoder().encode(
                'archive containing governed workspace content',
              );
              const memory = aMemoryStore();
              await memory.put(key, bytes, 'application/x-tar');
              let changed = false;
              const mutate = async (): Promise<void> => {
                changed = true;
                if (change === 'policy') {
                  await db
                    .updateTable('workspaces')
                    .set({ access_policy_epoch: '2' })
                    .where('id', '=', workspace.id)
                    .execute();
                  await db
                    .updateTable('workspace_access_policies')
                    .set({ epoch: '2', revision: crypto.randomUUID(), require_mfa: true })
                    .where('workspace_id', '=', workspace.id)
                    .execute();
                } else if (change === 'caller' || change === 'original') {
                  await db
                    .updateTable('sessions')
                    .set({ revoked_at: clock.now() })
                    .where('id', '=', change === 'caller' ? caller.sessionId : original.sessionId)
                    .execute();
                } else if (change === 'caller_proof' || change === 'original_proof') {
                  await db
                    .updateTable('workspace_session_assurances')
                    .set({ ended_at: clock.now(), end_reason: 'source_revoked' })
                    .where('workspace_id', '=', workspace.id)
                    .where(
                      'session_id',
                      '=',
                      change === 'caller_proof' ? caller.sessionId : original.sessionId,
                    )
                    .execute();
                } else if (change === 'deleted_original') {
                  await db.deleteFrom('sessions').where('id', '=', original.sessionId).execute();
                } else if (change === 'owner') {
                  await db
                    .updateTable('workspace_members')
                    .set({ role: 'member' })
                    .where('workspace_id', '=', workspace.id)
                    .where('user_id', '=', user.userId)
                    .execute();
                } else if (change === 'scope') {
                  if (kind === 'workspace')
                    await db
                      .updateTable('workspace_exports')
                      .set({ source_session_id: null })
                      .where('id', '=', archiveId)
                      .execute();
                  else
                    await db
                      .updateTable('personal_exports')
                      .set({ source_workspace_ids: [] })
                      .where('id', '=', archiveId)
                      .execute();
                }
              };
              const storage: ObjectStore = {
                ...memory,
                get: async (name) => {
                  if (stage === 'store') {
                    await mutate();
                    return await memory.get(name);
                  }
                  const body = new ReadableStream<Uint8Array>(
                    {
                      pull: async (controller): Promise<void> => {
                        await mutate();
                        controller.enqueue(bytes);
                        controller.close();
                      },
                    },
                    { highWaterMark: 0 },
                  );
                  return { body, size: bytes.length };
                },
              };
              const app = createApp(
                testDependencies({ database: db, auth: aTestAuth(db), clock, storage }),
              );
              const get = async (path: string, token = caller.token): Promise<Response> =>
                await app.handle(
                  new Request(`https://purlay.test${path}`, {
                    headers: { cookie: `${SESSION_COOKIE}=${token}` },
                  }),
                );
              for (const session of [caller, original]) {
                const allowed = await get(
                  `/api/workspaces/${workspace.id}/security/access`,
                  session.token,
                );
                expect(allowed.status).toBe(200);
                expect(await allowed.json()).toMatchObject({ state: 'allowed' });
              }
              const ready = {
                id: archiveId,
                status: 'ready',
                source_session_id: originalSourceId,
                storage_key: key,
                size_bytes: bytes.length,
                created_at: clock.now(),
                finished_at: clock.now(),
                expires_at: new Date(clock.now().getTime() + 3_600_000),
              };
              if (kind === 'workspace')
                await db
                  .insertInto('workspace_exports')
                  .values({ ...ready, workspace_id: workspace.id, requested_by: user.userId })
                  .execute();
              else
                await db
                  .insertInto('personal_exports')
                  .values({ ...ready, user_id: user.userId, source_workspace_ids: [workspace.id] })
                  .execute();
              const path =
                kind === 'workspace'
                  ? `/api/workspaces/${workspace.id}/exports/${archiveId}/download`
                  : `/api/me/exports/${archiveId}/download`;
              const response = await get(path);
              const body = await response.text().then(
                (text) => ({ text, failed: false }),
                () => ({ text: '', failed: true }),
              );
              await app.settled();
              expect(changed).toBe(true);
              const status =
                stage === 'stream' || change === 'none'
                  ? 200
                  : change === 'policy' ||
                      change === 'owner' ||
                      change === 'company_original' ||
                      change === 'caller_proof' ||
                      change === 'original_proof'
                    ? 403
                    : change === 'scope'
                      ? 404
                      : 401;
              const result = {
                kind,
                stage,
                change,
                status: response.status,
                bodyFailed: body.failed,
                contentReleased: body.text.includes(
                  'archive containing governed workspace content',
                ),
                cleaned: memory.keys().length === 0,
              };
              observed.push(result);
              expect(result).toEqual({
                kind,
                stage,
                change,
                status,
                bodyFailed: stage === 'stream',
                contentReleased: change === 'none',
                cleaned: true,
              });
            });
          });
        }
      }
    }
    console.log(JSON.stringify({ exportHandoffReview: observed }));
  });

  const admissionSamples: number[] = [];
  test.each([
    { chunks: 4, change: 'none' },
    { chunks: 40, change: 'none' },
    { chunks: 40, change: 'policy' },
    { chunks: 40, change: 'lifetime' },
    { chunks: 40, change: 'native' },
  ])('bounded multiworkspace archive handoff %j', async (scenario) => {
    const growth: {
      chunks: number;
      change: string;
      admissionQueries: number;
      remainingQueries: number;
      delivered: number;
    }[] = [];
    await withoutRequest(async () => {
      await withRollback(async (db) => {
        const clock = aMovableClock(new Date());
        const user = await aUserRow(db, 'archive-volume-owner');
        const caller = await aSession(db, clock, user.userId);
        const original = await aSession(db, clock, user.userId);
        for (const session of [caller, original])
          await recordPrimaryAuthentication(db, session.sessionId, user.userId, {
            method: 'password',
            authenticatedAt: clock.now(),
          });
        const workspaceIds = Array.from({ length: 3 }, () => crypto.randomUUID());
        await db
          .insertInto('workspaces')
          .values(
            workspaceIds.map((id) => ({
              id,
              name: 'Archive volume',
              slug: aUniqueSlug('archive-volume'),
              access_policy_epoch: '1',
            })),
          )
          .execute();
        await db
          .insertInto('workspace_members')
          .values(
            workspaceIds.map((id) => ({ workspace_id: id, user_id: user.userId, role: 'owner' })),
          )
          .execute();
        await db
          .insertInto('workspace_access_policies')
          .values(
            workspaceIds.map((id) => ({
              workspace_id: id,
              epoch: '1',
              mode: 'enforced',
              sign_in: 'any',
              require_mfa: false,
            })),
          )
          .execute();
        const query = { enabled: false, count: 0, admission: 0 };
        const counted = db.withPlugin({
          transformQuery(args) {
            if (query.enabled) query.count += 1;
            return args.node;
          },
          transformResult(args) {
            return Promise.resolve(args.result);
          },
        });
        const lifetime: { sessionIdleTimeoutHours: 1 | null; sessionMaxAgeDays: 1 | null } = {
          sessionIdleTimeoutHours: null,
          sessionMaxAgeDays: null,
        };
        const memory = aMemoryStore();
        const archiveId = messageId(clock.now());
        const key = `review-volume/${archiveId}.tar`;
        await memory.put(key, new Uint8Array(1), 'application/x-tar');
        const firstDelivered = Promise.withResolvers<undefined>();
        const bytes = new Uint8Array(256 * 1024);
        let emitted = 0;
        const storage: ObjectStore = {
          ...memory,
          get: () => {
            query.enabled = true;
            const body = new ReadableStream<Uint8Array>(
              {
                pull: async (controller): Promise<void> => {
                  if (emitted === 0) query.admission = query.count;
                  if (emitted === scenario.chunks) {
                    controller.close();
                    return;
                  }
                  if (emitted === 1 && scenario.change !== 'none') {
                    await firstDelivered.promise;
                    if (scenario.change === 'lifetime') lifetime.sessionMaxAgeDays = 1;
                    else if (scenario.change === 'native')
                      await counted
                        .updateTable('sessions')
                        .set({ revoked_at: clock.now() })
                        .where('id', '=', caller.sessionId)
                        .execute();
                    else {
                      const workspaceId = workspaceIds[0];
                      if (workspaceId === undefined) throw new Error('Missing volume workspace');
                      await counted
                        .updateTable('workspaces')
                        .set({ access_policy_epoch: '2' })
                        .where('id', '=', workspaceId)
                        .execute();
                      await counted
                        .updateTable('workspace_access_policies')
                        .set({ epoch: '2', revision: crypto.randomUUID(), require_mfa: true })
                        .where('workspace_id', '=', workspaceId)
                        .execute();
                    }
                  }
                  controller.enqueue(bytes);
                  emitted += 1;
                },
              },
              { highWaterMark: 0 },
            );
            return Promise.resolve({ body, size: scenario.chunks * bytes.length });
          },
        };
        const app = createApp(
          testDependencies({
            database: counted,
            auth: aTestAuth(counted, { sessionLifetime: lifetime }),
            clock,
            storage,
          }),
        );
        for (const workspaceId of workspaceIds)
          for (const session of [caller, original]) {
            const result = await app.handle(
              new Request(`https://purlay.test/api/workspaces/${workspaceId}/security/access`, {
                headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
              }),
            );
            expect(result.status).toBe(200);
            await result.json();
          }
        await counted
          .insertInto('personal_exports')
          .values({
            id: archiveId,
            user_id: user.userId,
            status: 'ready',
            source_session_id: original.sessionId,
            source_workspace_ids: scenario.change === 'native' ? [] : workspaceIds,
            storage_key: key,
            size_bytes: scenario.chunks * bytes.length,
            created_at: clock.now(),
            finished_at: clock.now(),
            expires_at: new Date(clock.now().getTime() + 3_600_000),
          })
          .execute();
        const response = await app.handle(
          new Request(`https://purlay.test/api/me/exports/${archiveId}/download`, {
            headers: { cookie: `${SESSION_COOKIE}=${caller.token}` },
          }),
        );
        expect(response.status).toBe(200);
        const reader = response.body?.getReader();
        if (reader === undefined) throw new Error('Missing archive response stream');
        let delivered = 0;
        let failed = false;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            delivered += 1;
            firstDelivered.resolve(undefined);
          }
        } catch {
          failed = true;
        }
        await app.settled();
        const remainingQueries = query.count - query.admission;
        growth.push({
          ...scenario,
          admissionQueries: query.admission,
          remainingQueries,
          delivered,
        });
        expect(failed).toBe(scenario.change !== 'none');
        expect(delivered).toBe(scenario.change === 'none' ? scenario.chunks : 1);
        expect(memory.keys()).toEqual([]);
        if (scenario.change === 'none') expect(remainingQueries).toBe(scenario.chunks + 3);
      });
    });

    const result = growth[0];
    if (result === undefined) throw new Error('Missing archive volume result');
    if (scenario.change === 'none') {
      admissionSamples.push(result.admissionQueries);
      if (admissionSamples.length === 2) expect(admissionSamples[0]).toBe(admissionSamples[1]);
    }
    console.log(JSON.stringify({ exportHandoffGrowth: result }));
  });
});
