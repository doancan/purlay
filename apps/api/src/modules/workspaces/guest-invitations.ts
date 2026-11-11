/** Named guest invitations retain the normal token, quota and audit infrastructure. */
import { Value } from '@sinclair/typebox/value';
import type { Transaction } from '@purlay/db';
import {
  CreateGuestInvitationRequest,
  normalisedMailbox,
  type CreatedGuestInvitation,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError, routeNotFound } from '../../platform/errors';
import {
  assertMinted,
  entitledTo,
  requireWorkspaceMembership,
  type WorkspaceContext,
} from '../../platform/tenancy';
import { requireInvitationManager } from './invitation-manager';
import { createInvitation } from './invitations';
import type { WorkspaceChannels } from './channels-port';

export const createGuestInvitation = async (
  transaction: Transaction,
  clock: Clock,
  context: WorkspaceContext,
  request: CreateGuestInvitationRequest,
  channels: WorkspaceChannels,
): Promise<CreatedGuestInvitation> => {
  assertMinted(context);
  requireInvitationManager(context);
  if (!Value.Check(CreateGuestInvitationRequest, request))
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'The guest invitation did not match the contract.',
      details: {
        fields: Object.fromEntries(
          [...Value.Errors(CreateGuestInvitationRequest, request)].map((error) => [
            error.path.split('/')[1] ?? 'invitation',
            'Check this value.',
          ]),
        ),
      },
    });
  const email = normalisedMailbox(request.email);
  if (
    email === undefined ||
    (request.accessExpiresAt !== null && new Date(request.accessExpiresAt) <= clock.now())
  )
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Use a valid address and a future access expiry.',
      details: {
        fields:
          email === undefined
            ? { email: 'Use a valid email address.' }
            : { accessExpiresAt: 'Choose a future expiry.' },
      },
    });
  if (channels.guests === undefined) throw routeNotFound();
  await channels.guests.prepare(transaction, context, request.channelIds);
  // Serializes with role changes/removal without blocking a sender's workspace FK KEY SHARE.
  // UPDATE here would deadlock with a sender already waiting on the selected channel locks.
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
  if (!entitledTo(current, channels.guests.moduleId)) throw routeNotFound();
  const guest = {
    email,
    channelIds: [...request.channelIds],
    accessExpiresAt: request.accessExpiresAt,
  };
  const created = await createInvitation(transaction, clock, current, {
    access: guest,
    moduleId: channels.guests.moduleId,
  });
  return { ...created, guest };
};
