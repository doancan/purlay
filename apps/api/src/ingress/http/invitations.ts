/**
 * The invitation endpoints (`API.md` §3, D-115): validate, call one service, answer.
 *
 * Making, listing and revoking name a workspace and go through its membership guard, so a caller
 * outside it is `404`. Previewing and joining name no workspace: the token in the body is what
 * opens one — in the body because the request log writes every path.
 */
import {
  CreateInvitationRequest,
  CreateGuestInvitationRequest,
  type CreatedGuestInvitation,
  type GuestInvitationAvailability,
  type InvitationRecipientPage,
  InvitationRecipientQuery,
  type InvitationDeliveryPage,
  Uuid,
  OlderPageQuery,
  InvitationPassportRequest,
  InvitationTokenRequest,
  type CreatedInvitation,
  type InvitationPage,
  type InvitationPreview,
  type Membership,
} from '@purlay/types';
import {
  makeAndMailInvitation,
  makeAndMailGuestInvitation,
  resendInvitationRecipient,
  revokeInvitationRecipient,
  type InvitationLetter,
} from '../../modules/workspaces/invitation-mail';
import {
  acceptInvitation,
  listInvitations,
  previewInvitation,
  revokeInvitation,
} from '../../modules/workspaces/invitations';
import {
  issuePassport,
  PASSPORT_TTL_MS,
  PassportRefused,
} from '../../modules/workspaces/invitation-passport';
import {
  finishInvitationAttempt,
  listInvitationRecipients,
  listInvitationDeliveries,
} from '../../modules/workspaces/invitation-delivery';
import { AppError } from '../../platform/errors';
import { inviteCookie } from '../../platform/cookies';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import type { Outbox } from '../../platform/mail';
import { atomicallyOn } from '../../platform/transactions';
import { requireSession, requireIndependentSession } from './session';
import { queryOf, validated } from './validate';
import type { WorkspaceDependencies, MemberWriteDependencies } from './workspaces';
import { guestInvitationAvailability } from '../../modules/workspaces/guest-readiness';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishWorkspaceUpdated,
} from '../../platform/events';

/** What making a link needs to send it by e-mail (D-179 §5). */
export interface InvitationMailDependencies extends WorkspaceDependencies {
  readonly guestAccessReady?: boolean;
  /** The origin the link opens at. */
  readonly appUrl: string;
  /** Where letters are posted; absent where the server has no relay, and then nothing is sent. */
  readonly outbox: Outbox | undefined;
  /** Runs work after the answer is on its way (`platform/after-answer.ts`). */
  readonly later: (work: () => Promise<void>) => void;
}

export const readGuestInvitationAvailability = async (
  dependencies: InvitationMailDependencies,
  request: Request,
  workspaceId: string,
): Promise<GuestInvitationAvailability> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(dependencies.database, userId, workspaceId);
  return guestInvitationAvailability(
    context,
    dependencies.workspaceChannels,
    dependencies.guestAccessReady ?? false,
    dependencies.outbox !== undefined,
  );
};

export const makeGuestInvitation = async (
  dependencies: InvitationMailDependencies,
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<CreatedGuestInvitation> => {
  const { auth, database, clock, appUrl, outbox, later, workspaceChannels } = dependencies;
  const { userId } = await requireSession(auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const wanted = validated(CreateGuestInvitationRequest, body);
  const { created, letters } = await atomicallyOn(database)(
    async (transaction) =>
      await makeAndMailGuestInvitation(
        transaction,
        clock,
        context,
        wanted,
        { on: outbox !== undefined, appUrl },
        workspaceChannels,
        dependencies.guestAccessReady ?? false,
      ),
  );
  if (outbox !== undefined && letters.length > 0) {
    later(() => {
      post({ database, clock, outbox }, letters);
      return Promise.resolve();
    });
  }
  return created;
};

/**
 * `POST /api/workspaces/:workspaceId/invitations` — a new link, its token shown this once, and the
 * letters to the addresses sent with it queued. The letters are handed to the outbox only once the
 * transaction has committed and the answer is being made: a request that fails sends nothing, and a
 * relay that is slow or down changes nothing about the answer.
 */
export const makeInvitation = async (
  { auth, database, clock, appUrl, outbox, later }: InvitationMailDependencies,
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<CreatedInvitation> => {
  const { userId } = await requireSession(auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const wanted = validated(CreateInvitationRequest, body ?? {});
  const { created, letters } = await atomicallyOn(database)(
    async (transaction) =>
      await makeAndMailInvitation(transaction, clock, context, wanted, {
        on: outbox !== undefined,
        appUrl,
      }),
  );
  if (outbox !== undefined && letters.length > 0) {
    later(() => {
      post({ database, clock, outbox }, letters);
      return Promise.resolve();
    });
  }
  return created;
};

/** Each letter to the outbox, which returns at once: a failure there is the outbox's to log. */
const post = (
  {
    database,
    clock,
    outbox,
  }: Pick<InvitationMailDependencies, 'database' | 'clock'> & { readonly outbox: Outbox },
  letters: readonly InvitationLetter[],
): void => {
  for (const { attemptId, ...letter } of letters)
    outbox.post(letter, 'invitation', async (receipt) => {
      await finishInvitationAttempt(database, clock, attemptId, receipt);
    });
};

/** `GET /api/workspaces/:workspaceId/invitations` — the links that still open, newest first. */
export const readInvitations = async (
  { auth, database, clock }: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
): Promise<InvitationPage> => {
  const { userId } = await requireSession(auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const query = validated(OlderPageQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await listInvitations(database, clock, context, query);
};

/** `DELETE /api/workspaces/:workspaceId/invitations/:invitationId` — the link stops opening. */
export const dropInvitation = async (
  { auth, database, clock }: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
  invitationId: string,
): Promise<void> => {
  const { userId } = await requireSession(auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  await atomicallyOn(database)(async (transaction) => {
    await revokeInvitation(transaction, clock, context, invitationId);
  });
};

/** `POST /api/invitations/preview` — what the link in the body opens. */
export const lookAtInvitation = async (
  { auth, database, clock }: WorkspaceDependencies,
  request: Request,
  body: unknown,
): Promise<InvitationPreview> => {
  const { userId } = await requireSession(auth, request);
  const { token } = validated(InvitationTokenRequest, body);
  return await previewInvitation(database, clock, userId, token);
};

/** `POST /api/invitations/accept` — in, by the link in the body; answers the membership. */
export const joinByInvitation = async (
  {
    auth,
    database,
    clock,
    bus,
    log = NO_LOG,
    effectiveModules,
    workspaceChannels,
    guestAccessReady = false,
  }: MemberWriteDependencies,
  request: Request,
  body: unknown,
): Promise<Membership> => {
  const { userId } = await requireIndependentSession(auth, request);
  const { token } = validated(InvitationTokenRequest, body);
  const { membership, memberIds } = await atomicallyOn(database)(
    async (transaction) =>
      await acceptInvitation(
        transaction,
        clock,
        userId,
        token,
        effectiveModules,
        workspaceChannels,
        guestAccessReady,
      ),
  );
  await publishAfterCommit(log, [
    [
      publication('WORKSPACE_UPDATED', () =>
        publishWorkspaceUpdated(bus, clock, memberIds, membership.workspace.id),
      ),
    ],
  ]);
  return membership;
};

/**
 * `POST /api/invitations/passport` — public: a newcomer's pass to make an account on an invite-only
 * server by the link in the body (D-179 §5, R51). Without `email`, the browser is given the passport's
 * cookie, set here and never in the body; with it, the passport is for that address and nothing is set.
 * A link that does not open is the preview's own `404`; the answer never says whether an address has an
 * account.
 */
export const openPassport = async (
  { database, clock }: Pick<WorkspaceDependencies, 'database' | 'clock'>,
  body: unknown,
): Promise<{ readonly setCookie: readonly string[] }> => {
  const { token, email } = validated(InvitationPassportRequest, body);
  try {
    const { cookie } = await atomicallyOn(database)(
      async (transaction) => await issuePassport(transaction, clock, { token, email }),
    );
    return {
      setCookie: cookie === undefined ? [] : [inviteCookie(cookie, PASSPORT_TTL_MS / 1000)],
    };
  } catch (error) {
    if (!(error instanceof PassportRefused)) throw error;
    if (error.reason === 'invalid-address') {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'That is not an email address.',
        details: { fields: { email: 'is not an email address' } },
      });
    }
    // A passport lives an hour: that is the longest a place can stay taken.
    throw new AppError(
      {
        code: 'RATE_LIMITED',
        message: 'This invitation has been asked for too often just now. Try again in a while.',
      },
      { retryAfterSeconds: PASSPORT_TTL_MS / 1000 },
    );
  }
};

export const readInvitationRecipients = async (
  deps: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
): Promise<InvitationRecipientPage> => {
  const { userId } = await requireSession(deps.auth, request);
  const context = await requireWorkspaceMembership(deps.database, userId, workspaceId);
  return await listInvitationRecipients(
    deps.database,
    deps.clock,
    context,
    validated(InvitationRecipientQuery, queryOf(new URL(request.url), { numbers: ['limit'] })),
  );
};
export const readInvitationDeliveries = async (
  deps: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
  recipientId: string,
): Promise<InvitationDeliveryPage> => {
  const { userId } = await requireSession(deps.auth, request);
  const context = await requireWorkspaceMembership(deps.database, userId, workspaceId);
  return await listInvitationDeliveries(
    deps.database,
    deps.clock,
    context,
    validated(Uuid, recipientId),
    validated(OlderPageQuery, queryOf(new URL(request.url), { numbers: ['limit'] })),
  );
};
export const resendRecipient = async (
  deps: InvitationMailDependencies,
  request: Request,
  workspaceId: string,
  recipientId: string,
): Promise<void> => {
  const { userId } = await requireSession(deps.auth, request);
  const context = await requireWorkspaceMembership(deps.database, userId, workspaceId);
  const letter = await atomicallyOn(deps.database)(
    async (tx) =>
      await resendInvitationRecipient(
        tx,
        deps.clock,
        context,
        validated(Uuid, recipientId),
        {
          on: deps.outbox !== undefined,
          appUrl: deps.appUrl,
        },
        deps.workspaceChannels,
        deps.guestAccessReady ?? false,
      ),
  );
  const outbox = deps.outbox;
  if (outbox !== undefined)
    deps.later(() => {
      post({ database: deps.database, clock: deps.clock, outbox }, [letter]);
      return Promise.resolve();
    });
};
export const dropRecipient = async (
  deps: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
  recipientId: string,
): Promise<void> => {
  const { userId } = await requireSession(deps.auth, request);
  const context = await requireWorkspaceMembership(deps.database, userId, workspaceId);
  await atomicallyOn(deps.database)(async (tx) => {
    await revokeInvitationRecipient(tx, deps.clock, context, validated(Uuid, recipientId));
  });
};
