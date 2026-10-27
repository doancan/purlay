/**
 * The invitation endpoints (`API.md` §3, D-115): validate, call one service, answer.
 *
 * Making, listing and revoking name a workspace and go through its membership guard, so a caller
 * outside it is `404`. Previewing and joining name no workspace: the token in the body is what
 * opens one — in the body because the request log writes every path.
 */
import {
  CreateInvitationRequest,
  OlderPageQuery,
  InvitationPassportRequest,
  InvitationTokenRequest,
  type CreatedInvitation,
  type InvitationPage,
  type InvitationPreview,
  type Membership,
} from '@purlay/types';
import { makeAndMailInvitation } from '../../modules/workspaces/invitation-mail';
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
import { AppError } from '../../platform/errors';
import { inviteCookie } from '../../platform/cookies';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import type { MailMessage, Outbox } from '../../platform/mail';
import { atomicallyOn } from '../../platform/transactions';
import { requireSession } from './session';
import { queryOf, validated } from './validate';
import type { WorkspaceDependencies, MemberWriteDependencies } from './workspaces';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishWorkspaceUpdated,
} from '../../platform/events';

/** What making a link needs to send it by e-mail (D-179 §5). */
export interface InvitationMailDependencies extends WorkspaceDependencies {
  /** The origin the link opens at. */
  readonly appUrl: string;
  /** Where letters are posted; absent where the server has no relay, and then nothing is sent. */
  readonly outbox: Outbox | undefined;
  /** Runs work after the answer is on its way (`platform/after-answer.ts`). */
  readonly later: (work: () => Promise<void>) => void;
}

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
      post(outbox, letters);
      return Promise.resolve();
    });
  }
  return created;
};

/** Each letter to the outbox, which returns at once: a failure there is the outbox's to log. */
const post = (outbox: Outbox, letters: readonly MailMessage[]): void => {
  for (const letter of letters) outbox.post(letter, 'invitation');
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
  { auth, database, clock, bus, log = NO_LOG }: MemberWriteDependencies,
  request: Request,
  body: unknown,
): Promise<Membership> => {
  const { userId } = await requireSession(auth, request);
  const { token } = validated(InvitationTokenRequest, body);
  const { membership, memberIds } = await atomicallyOn(database)(
    async (transaction) => await acceptInvitation(transaction, clock, userId, token),
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
