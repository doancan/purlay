/**
 * The wizard's calls (`API.md` §2, `/setup/*`), in the wizard's own chunk.
 *
 * Not on the shared `Api`: the answers are plain types (`packages/types/src/setup.ts`) so no schema
 * lands in the main bundle, the claim and the lock need a header the shared client does not keep
 * (`Retry-After`), and every call here is one the wizard alone makes. The answers are checked as the
 * shared client checks them — the browser is the trust boundary — by small guards rather than schemas.
 *
 * `fetch` is an argument, so a test answers with whatever it likes and never waits on a network.
 */
import {
  FINISH_PROBLEMS,
  PROBE_REASONS,
  SETUP_STEPS,
  type ErrorCode,
  type FinishProblem,
  type ProbeResult,
  type SetupAdminAnswer,
  type SetupState,
  type SetupStep,
  type SetupStepRefusal,
  type SetupVerifyAnswer,
} from '@purlay/types';

/** What went wrong with a call. `NETWORK` and `MALFORMED` are the client's own, as in `data/errors.ts`. */
export class SetupFailure extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'NETWORK' | 'MALFORMED';
  /** Seconds, from `Retry-After`, when the server said how long to wait. */
  readonly retryAfter: number | null;
  /** The field messages of a `VALIDATION_FAILED`, keyed by field: for this wizard, the rule's name. */
  readonly fields: Readonly<Record<string, string>>;
  /** The reason of a `409 SETUP_STEP_REFUSED`. */
  readonly refusal: SetupStepRefusal | null;
  /** The `details.reason` of any refusal, as the server said it: `SERVER_CHANGE_REFUSED`'s (`API.md` §2). */
  readonly reason: string | null;

  constructor(
    status: number,
    code: ErrorCode | 'NETWORK' | 'MALFORMED',
    message: string,
    retryAfter: number | null = null,
    fields: Readonly<Record<string, string>> = {},
    refusal: SetupStepRefusal | null = null,
    reason: string | null = null,
  ) {
    super(message);
    this.name = 'SetupFailure';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.fields = fields;
    this.refusal = refusal;
    this.reason = reason;
  }
}

export const isSetupFailure = (value: unknown): value is SetupFailure =>
  value instanceof SetupFailure;

/** The part of `fetch` this client uses. */
export type SetupFetch = (input: string, init: RequestInit) => Promise<Response>;

interface GitHubTry {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly save: boolean;
}

interface SmtpTry {
  readonly smtpUrl: string;
  readonly from: string;
  readonly allowPlaintext: boolean;
  readonly locale: 'en' | 'tr';
  readonly save: boolean;
}

export interface SetupClient {
  readonly state: (signal?: AbortSignal) => Promise<SetupState>;
  readonly claim: (code: string) => Promise<void>;
  readonly admin: (input: {
    readonly name: string;
    readonly email: string;
    readonly password: string;
  }) => Promise<SetupAdminAnswer>;
  readonly confirmAddress: () => Promise<void>;
  readonly policy: (signUp: 'invite-only' | 'open') => Promise<void>;
  readonly github: (input: GitHubTry) => Promise<ProbeResult>;
  readonly skipGithub: () => Promise<void>;
  readonly smtp: (input: SmtpTry) => Promise<ProbeResult>;
  readonly skipSmtp: () => Promise<void>;
  /** The administrator's letter again, through the relay already kept (it is never shown to a browser). */
  readonly resendSmtp: (locale: 'en' | 'tr') => Promise<ProbeResult>;
  readonly workspace: (input: { readonly name: string; readonly slug: string }) => Promise<void>;
  readonly invite: () => Promise<void>;
  readonly finish: () => Promise<void>;
  readonly verify: (token: string) => Promise<SetupVerifyAnswer>;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const listOf = <T extends string>(value: unknown, allowed: readonly T[]): value is readonly T[] =>
  Array.isArray(value) && value.every((item) => allowed.some((one) => one === item));

/** Whether a body is a `SetupState` as far as this wizard reads it. */
const isSetupState = (value: unknown): value is SetupState =>
  isRecord(value) &&
  listOf<SetupStep>(value['steps'], SETUP_STEPS) &&
  typeof value['appUrl'] === 'string' &&
  typeof value['githubCallbackUrl'] === 'string' &&
  isRecord(value['settings']) &&
  Array.isArray(value['needsReentry']) &&
  isRecord(value['channels']) &&
  typeof value['channels']['github'] === 'boolean' &&
  typeof value['channels']['email'] === 'boolean' &&
  (value['admin'] === null || isRecord(value['admin'])) &&
  (value['workspace'] === null || isRecord(value['workspace'])) &&
  typeof value['canFinish'] === 'boolean' &&
  listOf<FinishProblem>(value['finishProblems'], FINISH_PROBLEMS);

/** Whether a body is a `ProbeResult`; a reason outside the closed set is not one. */
export const isProbeResult = (value: unknown): value is ProbeResult => {
  if (!isRecord(value)) return false;
  if (value['ok'] === true) return true;
  return (
    value['ok'] === false &&
    typeof value['raw'] === 'string' &&
    PROBE_REASONS.some((reason) => reason === value['reason'])
  );
};

export const malformed = (status: number): SetupFailure =>
  new SetupFailure(status, 'MALFORMED', 'The server answered with something unreadable.');

const failureOf = (status: number, text: string, retryAfter: string | null): SetupFailure => {
  const wait = retryAfter !== null && /^\d{1,7}$/.test(retryAfter) ? Number(retryAfter) : null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return status === 502 || status === 503 || status === 504
      ? new SetupFailure(status, 'NETWORK', 'The server could not be reached.', wait)
      : new SetupFailure(
          status,
          'MALFORMED',
          'The server answered with something unreadable.',
          wait,
        );
  }
  const error = isRecord(parsed) ? parsed['error'] : undefined;
  if (!isRecord(error) || typeof error['code'] !== 'string') {
    return new SetupFailure(
      status,
      'MALFORMED',
      'The server answered with something unreadable.',
      wait,
    );
  }
  const details = isRecord(error['details']) ? error['details'] : {};
  const rawFields = isRecord(details['fields']) ? details['fields'] : {};
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawFields)) {
    if (typeof value === 'string') fields[key] = value;
  }
  const reason = details['reason'];
  const refusal: SetupStepRefusal | null =
    reason === 'admin-exists' || FINISH_PROBLEMS.some((one) => one === reason)
      ? (reason as SetupStepRefusal)
      : null;
  // The code is the server's closed set; `ErrorCode` is checked on the shared client, here it is only
  // compared with the few this wizard reads, so an unknown one falls to the generic sentence.
  return new SetupFailure(
    status,
    error['code'] as ErrorCode,
    typeof error['message'] === 'string' ? error['message'] : '',
    wait,
    fields,
    refusal,
    typeof reason === 'string' ? reason : null,
  );
};

/** One call as every client here makes it: JSON in and out, same-origin cookies, a failure as a `SetupFailure`. */
export type JsonCall = (
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<{ readonly status: number; readonly json: unknown }>;

export const jsonCaller = (fetchFn: SetupFetch): JsonCall => {
  return async (
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ readonly status: number; readonly json: unknown }> => {
    let response: Response;
    try {
      response = await fetchFn(path, {
        method,
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      throw new SetupFailure(0, 'NETWORK', cause instanceof Error ? cause.message : 'No answer.');
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new SetupFailure(0, 'NETWORK', 'The answer stopped before it was whole.');
    }
    if (!response.ok) throw failureOf(response.status, text, response.headers.get('retry-after'));
    if (text === '') return { status: response.status, json: null };
    try {
      return { status: response.status, json: JSON.parse(text) as unknown };
    } catch {
      throw malformed(response.status);
    }
  };
};

export const createSetupClient = (fetchFn: SetupFetch): SetupClient => {
  const call = jsonCaller(fetchFn);
  const send = async (path: string, body?: unknown): Promise<void> => {
    await call('POST', path, body);
  };

  const probe = async (path: string, body: unknown): Promise<ProbeResult> => {
    const { status, json } = await call('POST', path, body);
    if (!isProbeResult(json)) throw malformed(status);
    return json;
  };

  return {
    state: async (signal): Promise<SetupState> => {
      const { status, json } = await call('GET', '/setup/state', undefined, signal);
      if (!isSetupState(json)) throw malformed(status);
      return json;
    },
    claim: (code) => send('/setup/claim', { code }),
    admin: async (input): Promise<SetupAdminAnswer> => {
      const { status, json } = await call('POST', '/setup/admin', input);
      if (!isRecord(json) || typeof json['signedIn'] !== 'boolean') throw malformed(status);
      return { signedIn: json['signedIn'] };
    },
    confirmAddress: () => send('/setup/address', { confirmed: true }),
    policy: (signUp) => send('/setup/policy', { signUp }),
    github: (input) => probe('/setup/github', input),
    skipGithub: () => send('/setup/github', { skip: true }),
    smtp: (input) => probe('/setup/smtp', input),
    skipSmtp: () => send('/setup/smtp', { skip: true }),
    resendSmtp: (locale) => probe('/setup/smtp', { resend: true, locale }),
    workspace: (input) => send('/setup/workspace', input),
    invite: () => send('/setup/invite'),
    finish: () => send('/setup/finish'),
    verify: async (token): Promise<SetupVerifyAnswer> => {
      const { status, json } = await call('POST', '/setup/verify', { token });
      if (!isRecord(json) || json['verified'] !== true) throw malformed(status);
      return { verified: true };
    },
  };
};
