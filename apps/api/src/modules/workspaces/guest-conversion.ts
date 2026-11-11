/** Explicitly widening a guest's authority shares the scope locks, membership mutex and atomic audit. */
import { Value } from '@sinclair/typebox/value';
import type { Transaction } from '@purlay/db';
import { ConvertGuestRequest, Uuid, type WorkspaceMember } from '@purlay/types';
import { AppError, routeNotFound } from '../../platform/errors';
import {
  assertMinted,
  entitledTo,
  requireWorkspaceMembership,
  type WorkspaceContext,
} from '../../platform/tenancy';
import type { Clock } from '../../platform/clock';
import { recordAudit } from '../audit/audit';
import { asProfile, PROFILE_COLUMNS } from '../users/profile';
import type { WorkspaceChannels } from './channels-port';
import { requireInvitationManager } from './invitation-manager';
import { guestAccessRecipients } from './guest-audience';

const missing = (): AppError =>
  new AppError({ code: 'USER_NOT_FOUND', message: 'That person is not in this workspace.' });

export const convertGuest = async (
  transaction: Transaction,
  clock: Clock,
  context: WorkspaceContext,
  userId: string,
  request: unknown,
  channels: WorkspaceChannels,
): Promise<{
  readonly member: WorkspaceMember;
  readonly changed: boolean;
  readonly notifyUserIds: readonly string[];
}> => {
  assertMinted(context);
  requireInvitationManager(context);
  if (!Value.Check(ConvertGuestRequest, request))
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Confirm the wider full-member access.',
      details: { fields: { confirmFullAccess: 'Confirm full membership access.' } },
    });
  if (!Value.Check(Uuid, userId)) throw missing();
  const initial = await requireWorkspaceMembership(
    transaction,
    context.userId,
    context.workspaceId,
  );
  requireInvitationManager(initial);
  if (channels.guests === undefined || !entitledTo(initial, channels.guests.moduleId))
    throw routeNotFound();
  const before = await transaction
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select('workspace_members.access_kind')
    .where('workspace_members.workspace_id', '=', initial.workspaceId)
    .where('workspace_members.user_id', '=', userId)
    .where('users.deleted_at', 'is', null)
    .executeTakeFirst();
  if (before === undefined) throw missing();
  const scope =
    before.access_kind === 'guest'
      ? await channels.guests.prepareEdit(transaction, initial, userId, undefined)
      : undefined;
  await transaction
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', context.workspaceId)
    .forNoKeyUpdate()
    .execute();
  const current = await requireWorkspaceMembership(
    transaction,
    context.userId,
    context.workspaceId,
  );
  requireInvitationManager(current);
  if (!entitledTo(current, channels.guests.moduleId)) throw routeNotFound();
  const target = await transaction
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select([
      'workspace_members.access_kind',
      'workspace_members.role',
      'workspace_members.joined_at',
      'workspace_members.guest_expires_at',
      'users.id',
      'users.username',
      'users.display_name',
      'users.avatar_url',
      ...PROFILE_COLUMNS,
    ])
    .where('workspace_members.workspace_id', '=', current.workspaceId)
    .where('workspace_members.user_id', '=', userId)
    .where('users.deleted_at', 'is', null)
    .forUpdate('workspace_members')
    .executeTakeFirst();
  if (target === undefined) throw missing();
  const changed = target.access_kind === 'guest';
  if (changed) {
    if (scope === undefined)
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'Access changed. Reload it before converting.',
        details: { fields: { guest: 'Reload the guest access.' } },
      });
    const applied = await scope.apply(clock.now(), false);
    await transaction
      .updateTable('workspace_members')
      .set({
        access_kind: 'member',
        guest_since: null,
        guest_expires_at: null,
        guest_modules: null,
      })
      .where('workspace_id', '=', current.workspaceId)
      .where('user_id', '=', userId)
      .execute();
    await recordAudit(transaction, clock, {
      workspaceId: current.workspaceId,
      actorUserId: current.userId,
      action: 'member.guest_converted',
      targetType: 'user',
      targetId: userId,
      metadata: {
        fromAccess: 'guest',
        toAccess: 'member',
        channelCount: String(applied.previousIds.length),
        fromExpiry:
          target.guest_expires_at === null
            ? 'none'
            : new Date(target.guest_expires_at).toISOString(),
      },
    });
  }
  return {
    member: {
      user: {
        id: target.id,
        username: target.username,
        displayName: target.display_name,
        avatarUrl: target.avatar_url,
      },
      role: target.role,
      joinedAt: new Date(target.joined_at).toISOString(),
      profile: asProfile(target),
    },
    changed,
    notifyUserIds: changed ? await guestAccessRecipients(transaction, current, userId) : [],
  };
};
