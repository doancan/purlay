/** New guest admission requires the operator to attest that every API and background reader was updated. */
import { AppError } from '../../platform/errors';
import { routeNotFound } from '../../platform/errors';
import { assertMinted, entitledTo, type WorkspaceContext } from '../../platform/tenancy';
import type { GuestInvitationAvailability } from '@purlay/types';
import type { WorkspaceChannels } from './channels-port';
import { requireInvitationManager } from './invitation-manager';

export const guestInvitationAvailability = (
  context: WorkspaceContext,
  channels: WorkspaceChannels,
  ready: boolean,
  email: boolean,
): GuestInvitationAvailability => {
  assertMinted(context);
  requireInvitationManager(context);
  if (channels.guests === undefined || !entitledTo(context, channels.guests.moduleId))
    throw routeNotFound();
  return { enabled: ready, email };
};

export const requireGuestAdmissionReady = (ready: boolean): void => {
  if (!ready)
    throw new AppError({
      code: 'PEERS_BEHIND',
      message: 'The deployment has not been marked ready for restricted guest access.',
    });
};
