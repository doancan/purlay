/** @needs-modules chat — actual committed rows make competing channel writers visible to the projector. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { fixedClock } from '../../../platform/clock';
import { AppError } from '../../../platform/errors';
import { aRoom } from '../../../testing/rooms';
import { requireManualWorkspaceSource } from '../../../modules/workspaces/provisioning/native-state';
import { lockWorkspaceProjectionScope } from '../../../modules/workspaces/provisioning/scope';
import { projectChannelAccess } from './access-projection';

const clock = fixedClock(new Date('2026-11-13T00:00:00Z'));
let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

describe('integration: channel projection against committed competing writers', () => {
  test('a held member or parent row causes an immediate retry refusal with no projection write; release permits the same operation', async () => {
    const room = await clone.db.transaction().execute(async (db) => {
      const created = await aRoom(db, ['projection-lock-owner', 'projection-lock-member']);
      const scope = await lockWorkspaceProjectionScope(db, created.workspaceId);
      for (const member of Object.values(created.members))
        await requireManualWorkspaceSource(db, clock, scope, member.userId);
      await projectChannelAccess(
        db,
        clock,
        scope,
        Object.values(created.members).map((m) => m.userId),
      );
      return created;
    });
    const member = room.members['projection-lock-member'];
    if (member === undefined) throw new Error('Missing committed projection member');
    const before = await clone.db
      .selectFrom('channel_access_controls')
      .select('revision')
      .where('channel_id', '=', room.channelId)
      .where('user_id', '=', member.userId)
      .executeTakeFirstOrThrow();
    for (const heldRow of ['member', 'parent'] as const) {
      await clone.withFreshPool(async (locker) => {
        await locker.transaction().execute(async (held) => {
          if (heldRow === 'member')
            await held
              .selectFrom('channel_members')
              .select('id')
              .where('channel_id', '=', room.channelId)
              .where('user_id', '=', member.userId)
              .forUpdate()
              .executeTakeFirstOrThrow();
          else
            await held
              .selectFrom('channels')
              .select('id')
              .where('id', '=', room.channelId)
              .forUpdate()
              .executeTakeFirstOrThrow();
          await clone.withFreshPool(async (worker) => {
            await worker.transaction().execute(async (db) => {
              const scope = await lockWorkspaceProjectionScope(db, room.workspaceId);
              const outcome = await projectChannelAccess(db, clock, scope, [member.userId]).then(
                () => 'allowed',
                (error: unknown) => {
                  if (error instanceof AppError) return error.body.code;
                  throw error;
                },
              );
              expect(outcome).toBe('WORKSPACE_PROVISIONING_CHANGED');
              expect(
                await db
                  .selectFrom('channel_access_controls')
                  .select('revision')
                  .where('channel_id', '=', room.channelId)
                  .where('user_id', '=', member.userId)
                  .executeTakeFirstOrThrow(),
              ).toEqual(before);
              expect(
                await db
                  .selectFrom('channel_members')
                  .select('id')
                  .where('channel_id', '=', room.channelId)
                  .where('user_id', '=', member.userId)
                  .execute(),
              ).toHaveLength(1);
            });
          });
        });
      });
    }
    await clone.db.transaction().execute(async (db) => {
      const scope = await lockWorkspaceProjectionScope(db, room.workspaceId);
      expect(await projectChannelAccess(db, clock, scope, [member.userId])).toEqual([]);
      expect(
        await db
          .selectFrom('channel_access_controls')
          .select('revision')
          .where('channel_id', '=', room.channelId)
          .where('user_id', '=', member.userId)
          .executeTakeFirstOrThrow(),
      ).not.toEqual(before);
    });
  });
});
