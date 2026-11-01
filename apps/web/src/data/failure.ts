/**
 * What went wrong, in words a person can act on — one mapping for every place a request
 * can fail on a screen.
 *
 * Each call site used to have its own `catch` and its own sentence, and most had one
 * sentence for everything: "it failed". That says the same to someone who is offline, to
 * someone whose channel was removed and to someone whose session ended, and only the
 * first can fix it by trying again. The codes the API speaks are a closed set (D-47), so
 * the mapping is a table the compiler checks, not a habit.
 *
 * Two of the causes are the client's own and have no server code: a send that got no
 * answer in time (`TIMEOUT`) and a failure nobody described (`UNKNOWN`). The server's own
 * `message` is deliberately not shown: it is English, it is written for a log, and
 * `VALIDATION_FAILED`'s fields — the one place it names what the person typed — are read
 * by the form that sent them.
 */
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useI18n } from '../i18n/i18n-provider';
import { isApiError, type ApiErrorCode } from './errors';
import { keys } from './keys';

export type FailureCode = ApiErrorCode | 'TIMEOUT' | 'UNKNOWN';

/** The sentences, none of which has a placeholder — so a key is enough to say one. */
export type FailureKey =
  | 'failure.network'
  | 'failure.session'
  | 'failure.reauthenticate'
  | 'failure.twoFactor'
  | 'failure.notAMember'
  | 'failure.gone'
  | 'failure.slow'
  | 'failure.tooLarge'
  | 'failure.refused'
  | 'failure.savedLimit'
  | 'failure.pinsLimit'
  | 'failure.bookmarksLimit'
  | 'failure.githubFeedsLimit'
  | 'failure.githubFeedExists'
  | 'failure.githubUnavailable'
  | 'failure.githubNotConnected'
  | 'failure.githubAuthorization'
  | 'failure.incidentOpen'
  | 'failure.incidentResolved'
  | 'failure.incidentRespondersLimit'
  | 'failure.incidentPostmortemChanged'
  | 'failure.generic';

/**
 * Why a send can fail without the server ever having it: no answer at all from the HTTP door — the
 * network, or a proxy's 502/503/504 while the API is down. Such a send is still pending in truth, and
 * a reconnect sends it again (`ARCHITECTURE.md` §5.3). A timeout, or anything the server said, stays
 * failed for the person: §5.3's "Retry" is theirs. The engine resends these, and a failed row says
 * so in place of asking the person to (#685): one set, so the two cannot disagree.
 */
export const UNREACHED: ReadonlySet<FailureCode> = new Set<FailureCode>(['NETWORK']);

/** The code of whatever was thrown; anything that is not an `ApiError` is a failure nobody described. */
export const codeOf = (error: unknown): FailureCode => (isApiError(error) ? error.code : 'UNKNOWN');

/** Which sentence says it. Exhaustive: a new server code is a compile error until it is placed. */
export const failureKey = (code: FailureCode): FailureKey => {
  switch (code) {
    case 'NETWORK':
    case 'TIMEOUT':
      return 'failure.network';
    case 'UNAUTHENTICATED':
      return 'failure.session';
    // Erasing an account wants a sign-in from the last minutes (D-139 §5).
    case 'REAUTHENTICATION_REQUIRED':
      return 'failure.reauthenticate';
    // The server holds the person back until their second step is on (D-239).
    case 'TWO_FACTOR_REQUIRED':
      return 'failure.twoFactor';
    // Writing in a public channel the person has not joined: the way on is Join (D-156).
    case 'NOT_A_CHANNEL_MEMBER':
      return 'failure.notAMember';
    case 'FORBIDDEN':
    case 'ROUTE_NOT_FOUND':
    case 'WORKSPACE_NOT_FOUND':
    case 'CHANNEL_NOT_FOUND':
    case 'MESSAGE_NOT_FOUND':
    case 'BOOKMARK_NOT_FOUND':
    case 'MESSAGE_VERSION_NOT_FOUND':
    case 'USER_NOT_FOUND':
    case 'ATTACHMENT_NOT_FOUND':
    case 'SESSION_NOT_FOUND':
    case 'INVITATION_NOT_FOUND':
    case 'EXPORT_NOT_FOUND':
    case 'SIGN_IN_LINK_NOT_FOUND':
    case 'NATIVE_CODE_NOT_FOUND':
    case 'GITHUB_FEED_NOT_FOUND':
    case 'INCIDENT_NOT_FOUND':
    case 'IMAGE_NOT_AVAILABLE':
      return 'failure.gone';
    case 'RATE_LIMITED':
      return 'failure.slow';
    case 'PAYLOAD_TOO_LARGE':
    case 'LENGTH_REQUIRED':
    case 'STORAGE_QUOTA_EXCEEDED':
    case 'IMAGE_TOO_LARGE':
      return 'failure.tooLarge';
    case 'IMAGE_UNREADABLE':
      return 'failure.refused';
    case 'SAVED_LIMIT':
      return 'failure.savedLimit';
    case 'PINS_LIMIT':
      return 'failure.pinsLimit';
    case 'BOOKMARKS_LIMIT':
      return 'failure.bookmarksLimit';
    case 'GITHUB_FEEDS_LIMIT':
      return 'failure.githubFeedsLimit';
    case 'GITHUB_FEED_EXISTS':
      return 'failure.githubFeedExists';
    case 'GITHUB_UNAVAILABLE':
      return 'failure.githubUnavailable';
    case 'GITHUB_NOT_CONNECTED':
      return 'failure.githubNotConnected';
    case 'GITHUB_AUTHORIZATION_REQUIRED':
      return 'failure.githubAuthorization';
    case 'INCIDENT_OPEN':
      return 'failure.incidentOpen';
    case 'INCIDENT_RESOLVED':
      return 'failure.incidentResolved';
    case 'INCIDENT_RESPONDERS_LIMIT':
      return 'failure.incidentRespondersLimit';
    case 'INCIDENT_POSTMORTEM_CHANGED':
      return 'failure.incidentPostmortemChanged';
    case 'TOO_MANY_PENDING_UPLOADS':
    case 'ATTACHMENT_ID_CONFLICT':
    case 'LAST_OWNER':
    case 'EXPORT_IN_PROGRESS':
    case 'LAST_CHANNEL_MEMBER':
    // Said in words of its own by the channel's retention form (D-225); anywhere else, refused.
    case 'RETENTION_TOO_SHORT':
      return 'failure.refused';
    case 'VALIDATION_FAILED':
    case 'INVALID_MESSAGE_ID':
    case 'UNSUPPORTED_MEDIA_TYPE':
    case 'THREAD_NOT_RESOLVABLE':
    case 'WORKSPACE_SLUG_TAKEN':
    case 'CHANNEL_NAME_TAKEN':
    case 'KNOWLEDGE_CONFLICT':
    case 'SAVED_SEARCH_NOT_FOUND':
    case 'SAVED_SEARCH_LIMIT':
    case 'MESSAGE_ID_CONFLICT':
    case 'GITHUB_REQUEST_CONFLICT':
    case 'INCIDENT_ID_CONFLICT':
    case 'ACCOUNT_EMAIL_CONFLICT':
    // A lost race on the GitHub id's index, said by the callback as `failed` (D-179).
    case 'GITHUB_ACCOUNT_TAKEN':
      return 'failure.refused';
    case 'DATABASE_UNAVAILABLE':
    case 'STORAGE_UNAVAILABLE':
    case 'PUSH_UNAVAILABLE':
    case 'EMAIL_SIGN_IN_UNAVAILABLE':
    // The setup's own: its screens say each in words of their own (`UX.md` §11); anywhere else, generic.
    case 'SETUP_UNAVAILABLE':
    case 'SETUP_LOCKED':
    case 'SETUP_STEP_REFUSED':
    case 'SETTINGS_CHANGE_FAILED':
    case 'SERVER_CHANGE_REFUSED':
    case 'ADMIN_LINK_NOT_FOUND':
    // The stop page says it in words of its own (D-240).
    case 'MAIL_LINK_NOT_FOUND':
    // Said to an installed client by its header, which the web client never sends (D-186).
    case 'CLIENT_TOO_OLD':
    // GitHub's answers, never a person's: no screen calls the webhook (D-134 §4).
    case 'WEBHOOK_SIGNATURE_INVALID':
    case 'GITHUB_REPOSITORY_MISMATCH':
    case 'INTERNAL':
    case 'MALFORMED':
    case 'UNKNOWN':
      return 'failure.generic';
  }
};

/**
 * A 401 on an action is the session ending, not a reason to keep pressing the button: the
 * identity is asked for again, so the session gate takes over and the person is taken to
 * sign in. A `TWO_FACTOR_REQUIRED` is the same move: the identity read again says the person must
 * turn on two-step verification, and the gate shows them only that (D-239).
 */
const refreshSession = (client: QueryClient): void => {
  void client.invalidateQueries({ queryKey: keys.me });
};

/** The sentence for a failure, in the language the person reads, with the 401 consequence applied. */
export const useDescribeFailure = (): ((error: unknown) => string) => {
  const { t } = useI18n();
  const client = useQueryClient();
  return useCallback(
    (error: unknown): string => {
      const code = codeOf(error);
      if (code === 'UNAUTHENTICATED' || code === 'TWO_FACTOR_REQUIRED') refreshSession(client);
      return t(failureKey(code));
    },
    [t, client],
  );
};
