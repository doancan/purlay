/** Expiry and scope changes share the membership mutex, transaction and audit trail. */
import { Value } from '@sinclair/typebox/value';
import type { Transaction } from '@purlay/db';
import { UpdateGuestAccessRequest, Uuid, type UpdatedGuestAccess } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError, routeNotFound } from '../../platform/errors';
import {
  assertMinted,
  entitledTo,
  requireWorkspaceMembership,
  type WorkspaceContext,
} from '../../platform/tenancy';
import { recordAudit } from '../audit/audit';
import { requireInvitationManager } from './invitation-manager';
import type { WorkspaceChannels } from './channels-port';
import { guestAccessRecipients } from './guest-audience';
import { requireGuestAdmissionReady } from './guest-readiness';

export const updateGuestAccess = async (
  transaction: Transaction,
  clock: Clock,
  context: WorkspaceContext,
  userId: string,
  request: unknown,
  channels: WorkspaceChannels,
  guestAccessReady = false,
): Promise<{
  readonly guest: UpdatedGuestAccess;
  readonly changed: boolean;
  readonly revokeChannelIds: readonly string[];
  readonly notifyUserIds: readonly string[];
}> => {
  assertMinted(context);
  requireInvitationManager(context);
  if (!Value.Check(UpdateGuestAccessRequest, request))
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'The guest access edit did not match the contract.',
      details: { fields: { guest: 'Check the guest access edit.' } },
    });
  if (!Value.Check(Uuid, userId))
    throw new AppError({ code: 'USER_NOT_FOUND', message: 'That guest is not in this workspace.' });
  const initial = await requireWorkspaceMembership(
    transaction,
    context.userId,
    context.workspaceId,
  );
  requireInvitationManager(initial);
  if (channels.guests === undefined || !entitledTo(initial, channels.guests.moduleId))
    throw routeNotFound();
  const scope = await channels.guests.prepareEdit(transaction, initial, userId, request.channelIds);
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
      'workspace_members.joined_at',
      'workspace_members.guest_since',
      'workspace_members.guest_expires_at',
    ])
    .where('workspace_members.workspace_id', '=', current.workspaceId)
    .where('workspace_members.user_id', '=', userId)
    .where('workspace_members.access_kind', '=', 'guest')
    .where('users.deleted_at', 'is', null)
    .forUpdate('workspace_members')
    .executeTakeFirst();
  if (target === undefined)
    throw new AppError({ code: 'USER_NOT_FOUND', message: 'That guest is not in this workspace.' });
  if (target.guest_since === null) throw new Error('A guest membership has no history floor');
  const at = clock.now();
  if (
    request.accessExpiresAt !== undefined &&
    request.accessExpiresAt !== null &&
    new Date(request.accessExpiresAt) <= at
  )
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Choose a future access expiry.',
      details: { fields: { accessExpiresAt: 'Choose a future expiry.' } },
    });
  const expiry =
    request.accessExpiresAt === undefined
      ? target.guest_expires_at
      : request.accessExpiresAt === null
        ? null
        : new Date(request.accessExpiresAt);
  const expiryChanged =
    (expiry === null ? null : new Date(expiry).toISOString()) !==
    (target.guest_expires_at === null ? null : new Date(target.guest_expires_at).toISOString());
  const reactivated =
    request.accessExpiresAt !== undefined &&
    target.guest_expires_at !== null &&
    new Date(target.guest_expires_at) <= at;
  if (reactivated) requireGuestAdmissionReady(guestAccessReady);
  const since = reactivated ? at : target.guest_since;
  const joinedAt = reactivated ? at : target.joined_at;
  await transaction
    .updateTable('workspace_members')
    .set({ guest_since: since, guest_expires_at: expiry, joined_at: joinedAt })
    .where('workspace_id', '=', current.workspaceId)
    .where('user_id', '=', userId)
    .execute();
  const applied = await scope.apply(at, reactivated);
  const changed = expiryChanged || applied.changed;
  if (changed)
    await recordAudit(transaction, clock, {
      workspaceId: current.workspaceId,
      actorUserId: current.userId,
      action: 'member.guest_access_changed',
      targetType: 'user',
      targetId: userId,
      metadata: {
        added: String(applied.addedCount),
        removed: String(applied.removedIds.length),
        fromExpiry:
          target.guest_expires_at === null
            ? 'none'
            : new Date(target.guest_expires_at).toISOString(),
        toExpiry: expiry === null ? 'none' : new Date(expiry).toISOString(),
        reactivated: String(reactivated),
        fromHistorySince: new Date(target.guest_since).toISOString(),
        toHistorySince: new Date(since).toISOString(),
      },
    });
  return {
    guest: {
      joinedAt: new Date(joinedAt).toISOString(),
      access: {
        kind: 'guest',
        historySince: new Date(since).toISOString(),
        expiresAt: expiry === null ? null : new Date(expiry).toISOString(),
      },
      channelIds: [...applied.visibleIds],
      hiddenChannelCount: applied.hiddenCount,
    },
    changed,
    notifyUserIds: changed ? await guestAccessRecipients(transaction, current, userId) : [],
    revokeChannelIds:
      expiryChanged || reactivated ? [...applied.previousIds] : [...applied.removedIds],
  };
};
