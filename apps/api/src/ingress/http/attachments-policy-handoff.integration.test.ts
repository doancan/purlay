/** Stored file bytes retain policy, native and channel authority across asynchronous storage reads.
 * @needs-modules chat
 */
import { describe, afterAll, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { messageId } from '@purlay/types';
import { recordPrimaryAuthentication } from '../../modules/auth/authentication-evidence';
import type { SessionLifetime } from '../../modules/auth/session-lifetime';
import { sendMessage } from '../../features/chat/messages/messages';
import { workspaceAccessStatus } from '../../modules/workspaces/security/access';
import { credentialCipher } from '../../platform/crypto';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../../platform/config';
import { SESSION_COOKIE } from '../../platform/cookies';
import { withoutRequest } from '../../platform/logging';
import { requireWorkspaceSecurityMembership } from '../../platform/tenancy';
import type { ObjectStore } from '../../platform/storage';
import { aMovableClock, testDependencies } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { aSession, aTestAuth } from '../../testing/signed-in';
import { aMemoryStore } from '../../testing/storage';
import { createApp } from './app';

describe('integration: attachment policy handoff', () => {
  afterAll(closeIntegrationDatabase);

  for (const change of [
    'none',
    'store',
    'policy',
    'session',
    'channel',
    'lifetime',
    'activate',
    'cancel',
  ] as const) {
    test(`attachment byte handoff: ${change}`, async () => {
      await withRollback(async (database) => {
        const clock = aMovableClock(new Date());
        const room = await aRoom(database, ['file-owner'], { type: 'private' });
        const owner = room.members['file-owner'];
        if (owner === undefined) throw new Error('Missing attachment reader');
        const session = await aSession(database, clock, owner.userId);
        await recordPrimaryAuthentication(database, session.sessionId, owner.userId, {
          method: 'password',
          authenticatedAt: clock.now(),
        });
        const id = messageId(clock.now());
        const key = `w/${room.workspaceId}/${id}`;
        await database
          .insertInto('attachments')
          .values({
            id,
            workspace_id: room.workspaceId,
            uploader_id: owner.userId,
            storage_key: key,
            file_name: 'private.txt',
            mime_type: 'text/plain',
            size_bytes: '2',
          })
          .execute();
        await sendMessage(database, clock, owner.context, {
          id: messageId(new Date(clock.now().getTime() + 1)),
          content: 'A private file',
          attachmentIds: [id],
        });
        const context = await requireWorkspaceSecurityMembership(
          database,
          owner.userId,
          room.workspaceId,
        );
        if (change !== 'activate') {
          await database
            .updateTable('workspaces')
            .set({ access_policy_epoch: '1' })
            .where('id', '=', room.workspaceId)
            .execute();
          await database
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
        }
        const lifetime: { -readonly [K in keyof SessionLifetime]: SessionLifetime[K] } = {
          sessionIdleTimeoutHours: null,
          sessionMaxAgeDays: null,
        };
        expect(
          (
            await workspaceAccessStatus(
              {
                database,
                clock,
                cipher: credentialCipher(DEVELOPMENT_ENCRYPTION_KEY),
                lifetime: () => lifetime,
              },
              { context, sessionId: session.sessionId },
            )
          ).state,
        ).toBe('allowed');
        let cancelled = false;
        let position = 0;
        const mutate = async (): Promise<void> => {
          await withoutRequest(async () => {
            if (change === 'activate') {
              await database
                .updateTable('workspaces')
                .set({ access_policy_epoch: '1' })
                .where('id', '=', room.workspaceId)
                .execute();
              await database
                .insertInto('workspace_access_policies')
                .values({
                  workspace_id: room.workspaceId,
                  epoch: '1',
                  mode: 'enforced',
                  sign_in: 'any',
                  require_mfa: true,
                })
                .execute();
            }
            if (change === 'store' || change === 'policy')
              await database
                .updateTable('workspaces')
                .set({ access_policy_epoch: '2' })
                .where('id', '=', room.workspaceId)
                .execute();
            if (change === 'session')
              await database
                .updateTable('sessions')
                .set({ revoked_at: clock.now() })
                .where('id', '=', session.sessionId)
                .execute();
            if (change === 'channel')
              await database
                .deleteFrom('channel_members')
                .where('channel_id', '=', room.channelId)
                .where('user_id', '=', owner.userId)
                .execute();
            if (change === 'lifetime') lifetime.sessionMaxAgeDays = 1;
          });
        };
        const memory = aMemoryStore();
        const storage: ObjectStore = {
          ...memory,
          get: async () => {
            if (change === 'store') await mutate();
            return {
              size: 2,
              body: new ReadableStream<Uint8Array>(
                {
                  pull: async (controller): Promise<void> => {
                    if (position === 1) await mutate();
                    if (position < 2) controller.enqueue(new Uint8Array([++position]));
                    else controller.close();
                  },
                  cancel: (): void => {
                    cancelled = true;
                    if (change === 'store' || change === 'policy')
                      throw new Error('Storage cancellation failed after authority ended');
                  },
                },
                { highWaterMark: 0 },
              ),
            };
          },
        };
        const app = createApp(
          testDependencies({
            database,
            clock,
            storage,
            auth: aTestAuth(database, { sessionLifetime: lifetime }),
          }),
        );
        const response = await app.handle(
          new Request(`https://purlay.test/api/attachments/${id}`, {
            headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
          }),
        );
        if (change === 'store') {
          expect(response.status).toBe(403);
          expect(await response.json()).toMatchObject({
            error: { code: 'WORKSPACE_ACCESS_REQUIRED' },
          });
          expect(cancelled).toBe(true);
        } else {
          expect(response.status).toBe(200);
          const reader = response.body?.getReader();
          if (reader === undefined) throw new Error('Missing file stream');
          expect((await reader.read()).value).toEqual(new Uint8Array([1]));
          if (change === 'cancel') {
            await reader.cancel();
            expect(cancelled).toBe(true);
          } else if (change === 'none') {
            expect((await reader.read()).value).toEqual(new Uint8Array([2]));
            expect((await reader.read()).done).toBe(true);
          } else {
            expect(
              await reader.read().then(
                (next) => (next.value === undefined ? 'blocked' : 'released'),
                () => 'blocked',
              ),
            ).toBe('blocked');
            expect(cancelled).toBe(true);
          }
        }
        await app.settled();
      });
    });
  }
});
