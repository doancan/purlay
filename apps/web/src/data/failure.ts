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
  | 'failure.gone'
  | 'failure.slow'
  | 'failure.tooLarge'
  | 'failure.refused'
  | 'failure.savedLimit'
  | 'failure.generic';

/** The code of whatever was thrown; anything that is not an `ApiError` is a failure nobody described. */
export const codeOf = (error: unknown): FailureCode => (isApiError(error) ? error.code : 'UNKNOWN');

/** Which sentence says it. Exhaustive: a new server code is a compile error until it is placed. */
export const failureKey = (code: FailureCode): FailureKey => {
  switch (code) {
    case 'NETWORK':
    case 'TIMEOUT':
      return 'failure.network';
    case 'UNAUTHENTICATED':
    case 'OAUTH_STATE_INVALID':
    case 'EMAIL_REQUIRED':
      return 'failure.session';
    case 'FORBIDDEN':
    case 'ROUTE_NOT_FOUND':
    case 'WORKSPACE_NOT_FOUND':
    case 'CHANNEL_NOT_FOUND':
    case 'MESSAGE_NOT_FOUND':
    case 'USER_NOT_FOUND':
    case 'ATTACHMENT_NOT_FOUND':
    case 'INVITATION_NOT_FOUND':
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
    case 'TOO_MANY_PENDING_UPLOADS':
    case 'ATTACHMENT_ID_CONFLICT':
    case 'LAST_OWNER':
    case 'LAST_CHANNEL_MEMBER':
      return 'failure.refused';
    case 'VALIDATION_FAILED':
    case 'INVALID_MESSAGE_ID':
    case 'UNSUPPORTED_MEDIA_TYPE':
    case 'THREAD_NOT_RESOLVABLE':
    case 'WORKSPACE_SLUG_TAKEN':
    case 'CHANNEL_NAME_TAKEN':
    case 'MESSAGE_ID_CONFLICT':
    case 'ACCOUNT_EMAIL_CONFLICT':
      return 'failure.refused';
    case 'DATABASE_UNAVAILABLE':
    case 'STORAGE_UNAVAILABLE':
    case 'PUSH_UNAVAILABLE':
    case 'INTERNAL':
    case 'MALFORMED':
    case 'UNKNOWN':
      return 'failure.generic';
  }
};

/**
 * A 401 on an action is the session ending, not a reason to keep pressing the button: the
 * identity is asked for again, so the session gate takes over and the person is taken to
 * sign in.
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
      if (code === 'UNAUTHENTICATED') refreshSession(client);
      return t(failureKey(code));
    },
    [t, client],
  );
};
