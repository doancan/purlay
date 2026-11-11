// Invitations to a workspace: links, mailed recipients, their deliveries and the newcomer’s passport.
import {
  CreatedInvitation,
  CreatedGuestInvitation,
  GuestInvitationAvailability,
  InvitationDeliveryPage,
  InvitationPage,
  InvitationPreview,
  InvitationRecipientPage,
  Membership,
  type CreateInvitationRequest,
  type CreateGuestInvitationRequest,
  type InvitationRecipientQuery,
} from '@purlay/types';
import type { Http } from '../http';
import { at, options } from './request';

export interface InvitationsApi {
  readonly guestInvitationAvailability: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<GuestInvitationAvailability>;
  readonly createGuestInvitation: (
    workspaceId: string,
    input: CreateGuestInvitationRequest,
  ) => Promise<CreatedGuestInvitation>;
  /** What an invitation's token opens (D-115); the token goes in the body, never the path. */
  readonly previewInvitation: (token: string, signal?: AbortSignal) => Promise<InvitationPreview>;
  readonly acceptInvitation: (token: string) => Promise<Membership>;
  /** An owner's or an admin's: a new link, its token in this answer only. */
  readonly createInvitation: (
    workspaceId: string,
    mail?: CreateInvitationRequest,
  ) => Promise<CreatedInvitation>;
  readonly invitations: (
    workspaceId: string,
    before?: string,
    signal?: AbortSignal,
  ) => Promise<InvitationPage>;
  readonly invitationRecipients: (
    workspaceId: string,
    query?: InvitationRecipientQuery,
    signal?: AbortSignal,
  ) => Promise<InvitationRecipientPage>;
  readonly invitationDeliveries: (
    workspaceId: string,
    recipientId: string,
    before?: string,
    signal?: AbortSignal,
  ) => Promise<InvitationDeliveryPage>;
  readonly resendInvitationRecipient: (workspaceId: string, recipientId: string) => Promise<void>;
  readonly revokeInvitationRecipient: (workspaceId: string, recipientId: string) => Promise<void>;
  readonly revokeInvitation: (workspaceId: string, invitationId: string) => Promise<void>;
  /** An invitation's passport, so a newcomer may make an account on an invite-only server (R51). */
  readonly openInvitationPassport: (input: { token: string; email?: string }) => Promise<void>;
}

export const createInvitationsApi = (http: Http): InvitationsApi => ({
  guestInvitationAvailability: (workspaceId, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/guest-invitations`,
      GuestInvitationAvailability,
      options({}, signal),
    ),
  createGuestInvitation: (workspaceId, input) =>
    http.request(
      'POST',
      `/api/workspaces/${at(workspaceId)}/guest-invitations`,
      CreatedGuestInvitation,
      options({ body: input }),
    ),
  previewInvitation: (token, signal) =>
    http.request(
      'POST',
      '/api/invitations/preview',
      InvitationPreview,
      options({ body: { token } }, signal),
    ),
  acceptInvitation: (token) =>
    http.request('POST', '/api/invitations/accept', Membership, options({ body: { token } })),
  createInvitation: (workspaceId, mail) =>
    http.request(
      'POST',
      `/api/workspaces/${at(workspaceId)}/invitations`,
      CreatedInvitation,
      options({ body: mail ?? {} }),
    ),
  invitations: (workspaceId, before, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/invitations`,
      InvitationPage,
      options(before === undefined ? {} : { query: { before } }, signal),
    ),
  invitationRecipients: (workspaceId, query = {}, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/invitation-recipients`,
      InvitationRecipientPage,
      options({ query }, signal),
    ),
  invitationDeliveries: (workspaceId, recipientId, before, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/invitation-recipients/${at(recipientId)}/attempts`,
      InvitationDeliveryPage,
      options(before === undefined ? {} : { query: { before } }, signal),
    ),
  resendInvitationRecipient: (workspaceId, recipientId) =>
    http.send(
      'POST',
      `/api/workspaces/${at(workspaceId)}/invitation-recipients/${at(recipientId)}/resend`,
    ),
  revokeInvitationRecipient: (workspaceId, recipientId) =>
    http.send(
      'DELETE',
      `/api/workspaces/${at(workspaceId)}/invitation-recipients/${at(recipientId)}`,
    ),
  revokeInvitation: (workspaceId, invitationId) =>
    http.send(
      'DELETE',
      `/api/workspaces/${at(workspaceId)}/invitations/${at(invitationId)}`,
      options(),
    ),
  openInvitationPassport: (input) =>
    http.send('POST', '/api/invitations/passport', options({ body: input })),
});
