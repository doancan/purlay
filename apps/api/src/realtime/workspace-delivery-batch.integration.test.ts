/** Actual source reads stay bounded by cohort size, while every final statement retains its exact native fence. @needs-modules chat */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
  type Executor,
  type Selectable,
  type Database,
} from '@purlay/db';
import { parseServerMessage, type ServerFrame } from '@purlay/types';
import { mkdir, writeFile } from 'node:fs/promises';
import { aSession, aTestAuth, TEST_AUTH_SECRET } from '../testing/signed-in';
import { aRoom } from '../testing/rooms';
import { aMovableClock } from '../testing/doubles';
import { SESSION_COOKIE } from '../platform/cookies';
import { NO_LOG } from '../platform/events';
import { withinRequest } from '../platform/logging';
import { activeWorkspaceMembership, requireWorkspaceSecurityMembership } from '../platform/tenancy';
import { readWorkspaceContentPermits } from '../platform/workspace-content-fence';
import { credentialCipher } from '../platform/crypto';
import { DEFAULT_DEADLINE_MS } from '../platform/request-deadline';
import { BUDGETS } from '../cli/budget-latency';
import { recordPrimaryAuthentication } from '../modules/auth/authentication-evidence';
import { NO_SESSION_LIFETIME } from '../modules/auth/session-lifetime';
import { workspaceAccessStatus } from '../modules/workspaces/security/access';
import { workspaceFrameProjector } from '../features/chat/channels/workspace-delivery';
import { liveChannelScope } from '../features/chat/channels/live-history';
import { requireChannelById } from '../features/chat/channels/guard';
import { withinDeferredSource } from '../platform/deferred-source';
import { createSocketHub } from './hub';
import { companyWorkspaceMfaActor } from '../modules/workspaces/security/mfa.testing';
import { companySessionCookies } from '../modules/auth/company-sessions';
import { companyFrameProjector } from '../features/chat/channels/company-delivery';

describe('integration: workspace delivery cohort bounds', () => {
  describe.each([false, true])(
    'integration: workspace delivery cohort bounds, company=%s',
    (company) => {
      let clone: ClonedDatabase;
      let runCohort: () => Promise<void>;
      beforeAll(async () => {
        clone = await cloneIntegrationDatabase();
        const db = clone.db;
        const room = await aRoom(db, ['cohort']);
        const person = room.members['cohort'];
        if (person === undefined) throw new Error('Missing cohort owner');
        const clock = aMovableClock(new Date());
        let first = await aSession(db, clock, person.userId);
        await recordPrimaryAuthentication(db, first.sessionId, person.userId, {
          method: 'password',
          authenticatedAt: clock.now(),
        });
        let companyProof: Selectable<Database['workspace_identity_sessions']> | undefined;
        if (company) {
          const configured = await companyWorkspaceMfaActor(
            {
              database: db,
              clock,
              lifetime: () => NO_SESSION_LIFETIME,
              cipher: credentialCipher(Buffer.alloc(32, 7).toString('base64')),
            },
            {
              context: await requireWorkspaceSecurityMembership(
                db,
                person.userId,
                room.workspaceId,
              ),
              sessionId: first.sessionId,
            },
          );
          companyProof = await db
            .selectFrom('workspace_identity_sessions')
            .selectAll()
            .where('session_id', '=', configured.actor.sessionId)
            .executeTakeFirstOrThrow();
          first = await aSession(db, clock, person.userId, 30, {
            companyWorkspaceId: room.workspaceId,
          });
          await db
            .insertInto('workspace_identity_sessions')
            .values({ ...companyProof, session_id: first.sessionId })
            .execute();
          await recordPrimaryAuthentication(db, first.sessionId, person.userId, {
            method: 'company_oidc',
            authenticatedAt: clock.now(),
            companyWorkspaceId: room.workspaceId,
            companyConnectionId: companyProof.connection_id,
            companyAuthenticationRevision: companyProof.authentication_revision,
          });
        }
        await db
          .updateTable('workspaces')
          .set({ access_policy_epoch: '1' })
          .where('id', '=', room.workspaceId)
          .execute();
        await db
          .insertInto('workspace_access_policies')
          .values({
            workspace_id: room.workspaceId,
            epoch: '1',
            mode: 'enforced',
            sign_in: 'any',
            require_mfa: false,
            idle_minutes: 15,
            max_age_hours: 1,
            mfa_max_age_minutes: 5,
          })
          .execute();
        const dependencies = {
          database: db,
          clock,
          sessionLifetime: (): typeof NO_SESSION_LIFETIME => NO_SESSION_LIFETIME,
        };
        await workspaceAccessStatus(
          {
            ...dependencies,
            lifetime: dependencies.sessionLifetime,
            cipher: credentialCipher(Buffer.alloc(32, 7).toString('base64')),
          },
          {
            context: await requireWorkspaceSecurityMembership(db, person.userId, room.workspaceId),
            sessionId: first.sessionId,
          },
        );
        const evidence = await db
          .selectFrom('session_authentication_evidence')
          .selectAll()
          .where('session_id', '=', first.sessionId)
          .executeTakeFirstOrThrow();
        const assurance = await db
          .selectFrom('workspace_session_assurances')
          .selectAll()
          .where('session_id', '=', first.sessionId)
          .executeTakeFirstOrThrow();
        const sessions = [first];
        for (let index = 1; index < 120; index++)
          sessions.push(
            await aSession(
              db,
              clock,
              person.userId,
              30,
              company ? { companyWorkspaceId: room.workspaceId } : {},
            ),
          );
        if (companyProof !== undefined) {
          const proof = companyProof;
          await db
            .insertInto('workspace_identity_sessions')
            .values(
              sessions.slice(1).map((session) => ({ ...proof, session_id: session.sessionId })),
            )
            .execute();
        }
        await db
          .insertInto('session_authentication_evidence')
          .values(
            sessions.slice(1).map((session) => ({ ...evidence, session_id: session.sessionId })),
          )
          .execute();
        await db
          .insertInto('workspace_session_assurances')
          .values(
            sessions.slice(1).map((session) => ({ ...assurance, session_id: session.sessionId })),
          )
          .execute();
        runCohort = async (): Promise<void> => {
          let reads = 0;
          const roots = new Map<string, number>();
          const starts = new Map<unknown, { at: number; kind: string }>();
          let completedSelects = 0;
          const queryTimes: { kind: string; ms: number; startMs: number; endMs: number }[] = [];
          let fanoutStart = 0;
          const counted = db.withPlugin({
            transformQuery: (
              args,
            ): ReturnType<Parameters<Executor['withPlugin']>[0]['transformQuery']> => {
              if (args.node.kind === 'SelectQueryNode') {
                reads++;
                const root =
                  (args.node.from?.froms[0]?.kind ?? 'none') +
                  ':' +
                  String(args.node.setOperations?.length ?? 0);
                roots.set(root, (roots.get(root) ?? 0) + 1);
                starts.set(args.queryId, { at: performance.now(), kind: root });
              }
              return args.node;
            },
            transformResult: (args) => {
              const start = starts.get(args.queryId);
              if (start !== undefined) {
                completedSelects++;
                const end = performance.now();
                queryTimes.push({
                  kind: start.kind,
                  ms: end - start.at,
                  startMs: start.at - fanoutStart,
                  endMs: end - fanoutStart,
                });
              }
              return Promise.resolve(args.result);
            },
          });
          const counts: number[] = [];
          for (const size of [12, 120]) {
            reads = 0;
            completedSelects = 0;
            roots.clear();
            const permits = await readWorkspaceContentPermits(counted, {
              workspaceId: room.workspaceId,
              sessionIds: sessions.slice(0, size).map((session) => session.sessionId),
              now: clock.now(),
              lifetime: NO_SESSION_LIFETIME,
            });
            counts.push(completedSelects);
            expect(permits.size).toBe(size);
            expect([...permits.values()].every((permit) => permit.decision.allowed)).toBe(true);
          }
          const twelve = counts[0] ?? Infinity;
          const hundredTwenty = counts[1] ?? Infinity;
          expect(twelve).toBeLessThanOrEqual(8);
          expect(hundredTwenty).toBe(twelve * 2);
          const permit = (
            await readWorkspaceContentPermits(counted, {
              workspaceId: room.workspaceId,
              sessionIds: [first.sessionId],
              now: clock.now(),
              lifetime: NO_SESSION_LIFETIME,
            })
          ).get(first.sessionId);
          if (permit === undefined) throw new Error('Missing actual source permit');
          expect(() => {
            permit.capture(clock.now());
          }).toThrow('Verify workspace access');
          const scope = { requestId: 'cohort-source', startedAt: 0, sessionId: first.sessionId };
          await withinRequest(scope, () => {
            permit.capture(clock.now());
            return Promise.resolve();
          });

          const rawFrames: string[] = [];
          const receipts: number[] = [];
          const closed: number[] = [];
          const hub = createSocketHub(aTestAuth(counted, { clock }), clock, {
            log: NO_LOG,
            listen: () => undefined,
            leave: () => undefined,
            workspaceFrame: workspaceFrameProjector(counted, clock, dependencies.sessionLifetime),
            companyFrame: companyFrameProjector(counted, {
              clock,
              lifetime: dependencies.sessionLifetime,
            }),
          });
          try {
            const context = await withinDeferredSource(
              dependencies,
              { userId: person.userId, sessionId: first.sessionId },
              async () => await requireChannelById(db, person.userId, room.channelId),
            );
            const channelScope = liveChannelScope()(counted, context);
            for (const [index, session] of sessions.entries()) {
              let cookie = `${SESSION_COOKIE}=${session.token}`;
              if (company) {
                const response = await companySessionCookies(db, TEST_AUTH_SECRET).publicResponse(
                  new Response(null, {
                    headers: { 'set-cookie': `${cookie}; HttpOnly; Secure; Path=/` },
                  }),
                  false,
                );
                cookie = response.headers
                  .getSetCookie()
                  .map((line) => line.split(';')[0] ?? '')
                  .join('; ');
              }
              expect(
                await hub.opened(
                  String(index),
                  {
                    buffered: () => 0,
                    close: (code) => {
                      closed.push(code);
                    },
                    send: (text) => {
                      rawFrames.push(text);
                      if (fanoutStart > 0) receipts.push(performance.now() - fanoutStart);
                      return text.length;
                    },
                  },
                  new Request('https://purlay.test/ws', {
                    headers: { cookie },
                  }),
                ),
              ).toBeDefined();
              hub.restrictChannel?.(String(index), room.channelId, channelScope);
            }
            const frame: ServerFrame = {
              event: 'MESSAGE_REVISED',
              ts: 1,
              version: 1,
              data: {
                channelId: room.channelId,
                messageId: crypto.randomUUID(),
                parentId: null,
                content: 'actual bounded fanout',
                editedAt: null,
                deletedAt: null,
                mentions: [],
              },
            };
            reads = 0;
            completedSelects = 0;
            roots.clear();
            const start = performance.now();
            completedSelects = 0;
            queryTimes.length = 0;
            fanoutStart = start;
            for (const [index] of sessions.entries()) hub.deliver(String(index), frame);
            await hub.settled();
            const elapsedMs = performance.now() - start;
            // Browser trust-boundary validation follows the measured server byte handoff.
            const validationStart = performance.now();
            const sent = rawFrames.map((text) => {
              const parsed = parseServerMessage(text);
              if (parsed.kind !== 'frame') throw new Error('Invalid fanout frame');
              return parsed.frame;
            });
            const clientValidationMs = performance.now() - validationStart;
            const p95 =
              receipts.sort((left, right) => left - right)[Math.ceil(receipts.length * 0.95) - 1] ??
              Infinity;
            expect(sent).toHaveLength(120);
            expect(sent.every((value) => value.event === 'MESSAGE_REVISED')).toBe(true);
            expect(closed).toEqual([]);
            expect(elapsedMs).toBeLessThan(DEFAULT_DEADLINE_MS);
            const receipt = {
              nativeSources: [12, 120],
              factualSelects: counts,
              fanout: {
                sources: 120,
                sent: sent.length,
                totalSelects: reads,
                elapsedMs,
                receiptP95Ms: p95,
              },
              clientValidationMs,
              productFanoutBudgetMs: BUDGETS.fanOutMs,
              selectRootKinds: Object.fromEntries(roots),
              actualSelects: completedSelects,
              queryTimes,
              existingDeadlineMs: DEFAULT_DEADLINE_MS,
            };
            await mkdir('/tmp/purlay-workspace-ws-batch', { recursive: true, mode: 0o700 });
            await writeFile(
              `/tmp/purlay-workspace-ws-batch/performance-${company ? 'company' : 'independent'}.json`,
              JSON.stringify(receipt, null, 2),
              { mode: 0o600 },
            );
            if (!(p95 < BUDGETS.fanOutMs))
              console.error(
                JSON.stringify({ workspaceDeliveryCohortFailure: { company, ...receipt } }),
              );
            expect(p95).toBeLessThan(BUDGETS.fanOutMs);
          } finally {
            for (const [index] of sessions.entries()) hub.closed(String(index));
            await hub.settled();
          }
          await withinRequest(scope, async () => {
            permit.capture(clock.now());
            const rows = async (): Promise<number> =>
              (
                await counted
                  .selectFrom('workspaces')
                  .innerJoin('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
                  .select('workspaces.id')
                  .where('workspaces.id', '=', room.workspaceId)
                  .where('workspace_members.user_id', '=', person.userId)
                  .where(activeWorkspaceMembership())
                  .execute()
              ).length;
            expect(await rows()).toBe(1);
            await db
              .updateTable('workspaces')
              .set({ access_policy_epoch: '2' })
              .where('id', '=', room.workspaceId)
              .execute();
            expect(await rows()).toBe(0);
          });
          const revision = crypto.randomUUID();
          await db
            .updateTable('workspace_access_policies')
            .set({ epoch: '2', revision, require_mfa: true })
            .where('workspace_id', '=', room.workspaceId)
            .execute();
          const factor = await db
            .insertInto('workspace_mfa_factors')
            .values({
              workspace_id: room.workspaceId,
              user_id: person.userId,
              secret_encrypted: Buffer.from('sealed clock-bound fixture'),
              state: 'verified',
              verified_at: clock.now(),
            })
            .returning(['id', 'revision'])
            .executeTakeFirstOrThrow();
          await db
            .updateTable('workspace_session_assurances')
            .set({
              policy_epoch: '2',
              policy_revision: revision,
              factor_scope: 'workspace',
              factor_id: factor.id,
              factor_revision: factor.revision,
              mfa_verified_at: clock.now(),
              mfa_expires_at: new Date(clock.now().getTime() + 5_000),
            })
            .where('workspace_id', '=', room.workspaceId)
            .where('session_id', '=', first.sessionId)
            .execute();
          const fresh = (
            await readWorkspaceContentPermits(db, {
              workspaceId: room.workspaceId,
              sessionIds: [first.sessionId],
              now: clock.now(),
              lifetime: NO_SESSION_LIFETIME,
            })
          ).get(first.sessionId);
          if (fresh === undefined) throw new Error('Missing captured MFA source');
          expect(fresh.decision.allowed).toBe(true);
          clock.advance(5_001);
          await withinRequest(scope, () => {
            expect(() => {
              fresh.capture(clock.now());
            }).toThrow('Verify workspace access');
            return Promise.resolve();
          });
        };
      }, CLONE_HOOK_MS);
      afterAll(async () => {
        await clone.drop();
        await closeIntegrationDatabase();
      }, DROP_HOOK_MS);
      test('12 and 120 exact native sources use bounded factual reads and final fanout', async () => {
        await runCohort();
      });
    },
  );
});
