/**
 * What the wizard says about a failure, as data: one entry per reason a try can fail, built over the
 * contract's closed list — a reason added to `PROBE_REASONS` is a compile error here until it has its
 * sentences, and the sentences are catalogue keys, so a missing translation is one too (UX §11).
 *
 * Each is the same three things, in the same order: what happened, how to put it right, and — shown by
 * the screen, never stored here — the service's own words.
 */
import type { ProbeReason } from '@purlay/types';
import type { PlainKey } from '../../i18n/types';
import type { SetupFailure } from './client';

/** The field a reason points at, outlined on the screen that has it. */
type ProbeField = 'clientId' | 'clientSecret' | 'smtpUrl' | 'from' | 'admin';

/** How far a mail try got: the index of the line it stopped at, in `MAIL_STAGES`. */
export type MailStage = 0 | 1 | 2 | 3;

export const MAIL_STAGES = [
  'setup.email.stage.resolved',
  'setup.email.stage.connected',
  'setup.email.stage.login',
  'setup.email.stage.message',
] as const satisfies readonly PlainKey[];

export interface ReasonWords {
  readonly what: PlainKey;
  readonly fix: readonly PlainKey[];
  readonly field: ProbeField | null;
  /** For a mail reason, where the try stopped; GitHub's have no stages. */
  readonly stoppedAt: MailStage | null;
}

export const REASONS: Record<ProbeReason, ReasonWords> = {
  'secret-rejected': {
    what: 'setup.reason.secret-rejected.what',
    fix: ['setup.reason.secret-rejected.fix1', 'setup.reason.secret-rejected.fix2'],
    field: 'clientSecret',
    stoppedAt: null,
  },
  'client-unknown': {
    what: 'setup.reason.client-unknown.what',
    fix: ['setup.reason.client-unknown.fix1', 'setup.reason.client-unknown.fix2'],
    field: 'clientId',
    stoppedAt: null,
  },
  unreachable: {
    what: 'setup.reason.unreachable.what',
    fix: ['setup.reason.unreachable.fix1', 'setup.reason.unreachable.fix2'],
    field: 'smtpUrl',
    // Refused, timed out and not found are one reason. A refused port is the common case, and there
    // the address did resolve: the line it stopped at is the connection, not the address.
    stoppedAt: 1,
  },
  'tls-failed': {
    what: 'setup.reason.tls-failed.what',
    fix: ['setup.reason.tls-failed.fix1', 'setup.reason.tls-failed.fix2'],
    field: 'smtpUrl',
    stoppedAt: 1,
  },
  'auth-failed': {
    what: 'setup.reason.auth-failed.what',
    fix: [
      'setup.reason.auth-failed.fix1',
      'setup.reason.auth-failed.fix2',
      'setup.reason.auth-failed.fix3',
    ],
    field: 'smtpUrl',
    stoppedAt: 2,
  },
  'sender-refused': {
    what: 'setup.reason.sender-refused.what',
    fix: ['setup.reason.sender-refused.fix1'],
    field: 'from',
    stoppedAt: 3,
  },
  'recipient-refused': {
    what: 'setup.reason.recipient-refused.what',
    fix: ['setup.reason.recipient-refused.fix1', 'setup.reason.recipient-refused.fix2'],
    field: 'admin',
    stoppedAt: 3,
  },
  'message-refused': {
    what: 'setup.reason.message-refused.what',
    fix: ['setup.reason.message-refused.fix1', 'setup.reason.message-refused.fix2'],
    field: 'from',
    stoppedAt: 3,
  },
  'unexpected-reply': {
    what: 'setup.reason.unexpected-reply.what',
    fix: ['setup.reason.unexpected-reply.fix1', 'setup.reason.unexpected-reply.fix2'],
    field: 'smtpUrl',
    stoppedAt: 1,
  },
};

/** The sentence for a call that failed: a plain one, or the wait `Retry-After` asked for, in minutes. */
export const failureWords = (
  failure: SetupFailure,
):
  | {
      readonly kind: 'plain';
      readonly key: 'setup.failed.network' | 'setup.failed.order' | 'setup.failed.generic';
    }
  | { readonly kind: 'rate'; readonly minutes: number } => {
  if (failure.code === 'NETWORK') return { kind: 'plain', key: 'setup.failed.network' };
  if (failure.code === 'RATE_LIMITED') {
    return { kind: 'rate', minutes: Math.max(1, Math.ceil((failure.retryAfter ?? 60) / 60)) };
  }
  if (failure.code === 'SETUP_STEP_REFUSED') return { kind: 'plain', key: 'setup.failed.order' };
  return { kind: 'plain', key: 'setup.failed.generic' };
};
