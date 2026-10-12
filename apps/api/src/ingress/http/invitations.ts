/**
 * The invitation endpoints (`API.md` §3, D-115): validate, call one service, answer.
 *
 * Making, listing and revoking name a workspace and go through its membership guard, so a caller
 * outside it is `404`. Previewing and joining name no workspace: the token in the body is what
 * opens one — in the body because the request log writes every path.
 */
import {
  OlderPageQuery,
  InvitationTokenRequest,
  type CreatedInvitation,
  type InvitationPage,
  type InvitationPreview,
  type Membership,
} from '@purlay/types';
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  previewInvitation,
  revokeInvitation,
} from '../../modules/workspaces/invitations';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { requireSession } from './session';
import { queryOf, validated } from './validate';
import type { WorkspaceDependencies } from './workspaces';

/** `POST /api/workspaces/:workspaceId/invitations` — a new link, its token shown this once. */
export const makeInvitation = async (
  { database, clock }: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
): Promise<CreatedInvitation> => {
  const { userId } = await requireSession(database, clock, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await atomicallyOn(database)(
    async (transaction) => await createInvitation(transaction, clock, context),
  );
};

/** `GET /api/workspaces/:workspaceId/invitations` — the links that still open, newest first. */
export const readInvitations = async (
  { database, clock }: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
): Promise<InvitationPage> => {
  const { userId } = await requireSession(database, clock, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const query = validated(OlderPageQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await listInvitations(database, clock, context, query);
};

/** `DELETE /api/workspaces/:workspaceId/invitations/:invitationId` — the link stops opening. */
export const dropInvitation = async (
  { database, clock }: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
  invitationId: string,
): Promise<void> => {
  const { userId } = await requireSession(database, clock, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  await atomicallyOn(database)(async (transaction) => {
    await revokeInvitation(transaction, clock, context, invitationId);
  });
};

/** `POST /api/invitations/preview` — what the link in the body opens. */
export const lookAtInvitation = async (
  { database, clock }: WorkspaceDependencies,
  request: Request,
  body: unknown,
): Promise<InvitationPreview> => {
  const { userId } = await requireSession(database, clock, request);
  const { token } = validated(InvitationTokenRequest, body);
  return await previewInvitation(database, clock, userId, token);
};

/** `POST /api/invitations/accept` — in, by the link in the body; answers the membership. */
export const joinByInvitation = async (
  { database, clock }: WorkspaceDependencies,
  request: Request,
  body: unknown,
): Promise<Membership> => {
  const { userId } = await requireSession(database, clock, request);
  const { token } = validated(InvitationTokenRequest, body);
  return await atomicallyOn(database)(
    async (transaction) => await acceptInvitation(transaction, clock, userId, token),
  );
};
