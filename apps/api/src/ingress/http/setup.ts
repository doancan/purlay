/**
 * The setup in the browser, over HTTP (D-179 §4, `API.md` §2 `/setup/*`) — as functions that take a
 * request and say what the response is, like `auth.ts`; the routes are `app.ts`'s.
 *
 * - **One guard.** Every route but the status, the claim and the address link takes the claim's cookie
 *   (`SETUP_COOKIE`) through `requireSetupClaim`, before it reads anything else; what the guard mints
 *   is what the steps and the probes take, so none can be reached around it (Ruling R48).
 * - **One answer to everybody without the claim** (`404 SETUP_UNAVAILABLE`): setup finished, never
 *   claimed, claimed by another browser, a cookie wrong, idle or taken over. A caller without the claim
 *   learns whether the server is open to setup (`GET /setup/status`), and nothing else. Only two
 *   answers of the claim itself are told apart, because the operator needs them: a wrong code, and the
 *   server's lock on wrong codes, with `Retry-After`.
 * - **What the edge does first** (`app.ts`, `edge.ts`, `rate-limit.ts`): a cross-site write refused, a
 *   body that is not JSON or too long refused, a limit per client charged — all before this runs. Every
 *   answer is `no-store`, and every `/setup` path `noindex`.
 * - **Nothing secret comes back or goes to the log.** The code is `code`, the relay's address
 *   `smtpUrl`, GitHub's secret `clientSecret`, the password `password`, the link's `token`: names the
 *   logger never writes (`NEVER_LOGGED`). The administrator's sign-in gives back the library's
 *   `Set-Cookie` alone: its body carries the session's raw token.
 */
import { Value } from '@sinclair/typebox/value';
import {
  CreateWorkspaceRequest,
  SIGN_IN_CALLBACK,
  SetupAddressRequest,
  SetupAdminRequest,
  SetupClaimRequest,
  SetupGitHubRequest,
  SetupPolicyRequest,
  SetupSmtpRequest,
  SetupVerifyRequest,
  type ProbeResult,
  type SetupAdminAnswer,
  type SetupState,
  type SetupStatus,
  type SetupVerifyAnswer,
  type Workspace,
} from '@purlay/types';
import type { Executor } from '@purlay/db';
import type { Auth } from '../../modules/auth/better-auth';
import { AdminRefused, createAdmin, signInAdmin } from '../../modules/setup/admin';
import { CandidateRefused } from '../../modules/setup/probes';
import {
  SettingsChangeFailed,
  type RuntimeServices,
  type SettingsChange,
} from '../../modules/setup/runtime';
import { settingsView } from '../../modules/setup/settings';
import {
  claimSetup,
  requireSetupClaim,
  SETUP_CLAIM_IDLE_MS,
  SetupRefused,
  setupStatus,
  type SetupSession,
} from '../../modules/setup/setup';
import { verifyAdminEmail } from '../../modules/setup/verification';
import {
  choosePolicy,
  finishSetup,
  FinishRefused,
  makeFirstWorkspace,
  passStep,
  setupProgress,
  tryGitHub,
  tryRelay,
  type Serving,
  type WizardDependencies,
} from '../../modules/setup/wizard';
import type { Clock } from '../../platform/clock';
import type { Config } from '../../platform/config';
import { clearedSetupCookie, readCookie, SETUP_COOKIE, setupCookie } from '../../platform/cookies';
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import { validated } from './validate';

export interface SetupDependencies {
  readonly config: Config;
  /** The pool: a change of the settings commits in a transaction of its own. */
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
  /** The instance this request is served by: the administrator is made and signed in with it. */
  readonly auth: Auth;
  /**
   * What swaps the services when a step changes the settings (`applySettings`), and the holder whose
   * current pair says what serves. Absent where an application is built with an instance nothing swaps.
   */
  readonly settingsChange: SettingsChange | undefined;
}

/** What a setup route answers: its status, its body, and the cookies it sets. */
export interface SetupAnswer<T> {
  readonly status: 200 | 201 | 204;
  readonly body: T;
  readonly setCookie: readonly string[];
}

/** An answer to the holder: its claim's cookie sent again, so it lasts the claim's idle day from now. */
const answer = <T>(holder: Holder, body: T, status: 200 | 201 = 200): SetupAnswer<T> => ({
  status,
  body,
  setCookie: [holder.refresh],
});

const NOTHING: SetupAnswer<null> = { status: 204, body: null, setCookie: [] };

/** Everybody without the claim, whatever the reason: one answer. */
const unavailable = (): AppError =>
  new AppError({ code: 'SETUP_UNAVAILABLE', message: 'Setup is not available.' });

const linkNotFound = (): AppError =>
  new AppError({ code: 'ADMIN_LINK_NOT_FOUND', message: 'This link does not open.' });

/** A refusal of the setup's modules, as the contract says it. Anything else is passed on as it is. */
const asContract = (
  error: unknown,
  { log, clock }: Pick<SetupDependencies, 'log' | 'clock'>,
): unknown => {
  if (error instanceof SetupRefused) {
    const { refusal } = error;
    switch (refusal.reason) {
      case 'closed':
      case 'claimed':
      case 'not-claimed':
        return unavailable();
      case 'wrong-code':
        return new AppError({
          code: 'VALIDATION_FAILED',
          message: 'That is not the setup code.',
          details: { fields: { code: 'is not the setup code' } },
        });
      case 'locked':
        return new AppError(
          {
            code: 'SETUP_LOCKED',
            message:
              'Too many wrong setup codes. Wait, then try again; a restart of the server ends the wait.',
          },
          // In whole seconds, at least one: a lock that ends this second still refuses now.
          {
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((refusal.until.getTime() - clock.now().getTime()) / 1000),
            ),
          },
        );
      case 'out-of-order':
        return new AppError({
          code: 'SETUP_STEP_REFUSED',
          message: 'That step comes later.',
          details: { reason: 'out-of-order' },
        });
      case 'invalid-browser':
        // The browser's id is the server's own: a refusal of it is a defect, not the caller's.
        return error;
    }
  }
  if (error instanceof AdminRefused) {
    const { refusal } = error;
    switch (refusal.reason) {
      case 'admin-exists':
        return new AppError({
          code: 'SETUP_STEP_REFUSED',
          message: error.message,
          details: { reason: 'admin-exists' },
        });
      case 'email-taken':
        return new AppError({ code: 'ACCOUNT_EMAIL_CONFLICT', message: error.message });
      case 'invalid-email':
        return refusedField(error.message, 'email', 'is not an email address');
      case 'invalid-name':
        return refusedField(error.message, 'name', 'is one to 128 characters');
      case 'weak-password':
        // The rule's name: the wizard says each in words (`passwordProblem`).
        return refusedField(error.message, 'password', refusal.problem);
    }
  }
  if (error instanceof CandidateRefused) {
    return refusedField('That cannot be tried.', error.field, error.message);
  }
  if (error instanceof FinishRefused) {
    return new AppError({
      code: 'SETUP_STEP_REFUSED',
      message: error.message,
      details: { reason: error.problems[0] ?? 'out-of-order' },
    });
  }
  if (error instanceof SettingsChangeFailed) {
    // Which stage, never what was in the change; the cause is the server's, and may carry a value.
    log.error('a change of the server settings from the setup did not complete', {
      stage: error.stage,
      inEffect: error.inEffect,
      restartNeeded: error.restartNeeded,
      cause: error.cause instanceof Error ? error.cause.name : typeof error.cause,
    });
    if (error.stage === 'starting' || error.stage === 'shutting-down') {
      return new AppError({ code: 'DATABASE_UNAVAILABLE', message: error.message });
    }
    return new AppError({
      code: 'SETTINGS_CHANGE_FAILED',
      message: error.message,
      details: { stage: error.stage, restartNeeded: error.restartNeeded },
    });
  }
  return error;
};

export const refusedField = (message: string, field: string, why: string): AppError =>
  new AppError({ code: 'VALIDATION_FAILED', message, details: { fields: { [field]: why } } });

/** `work`, its refusals said as the contract says them. */
export const said = async <T>(
  dependencies: Pick<SetupDependencies, 'log' | 'clock'>,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw asContract(error, dependencies);
  }
};

/** What the guard proves of a request, and its cookie as it is sent back. */
interface Holder {
  readonly session: SetupSession;
  /** The claim's cookie again, for the claim's idle window from now: a claim in use stays open (R39). */
  readonly refresh: string;
}

/** The guard of every step: the session this request's claim cookie is, or the one answer. */
const theHolder = async (
  { database, clock }: SetupDependencies,
  request: Request,
): Promise<Holder> => {
  const token = readCookie(request.headers.get('cookie'), SETUP_COOKIE);
  try {
    const session = await requireSetupClaim(database, token, clock);
    return { session, refresh: setupCookie(token ?? '', SETUP_CLAIM_IDLE_MS / 1000) };
  } catch (error) {
    if (error instanceof SetupRefused) throw unavailable();
    throw error;
  }
};

/** The pair serving now, and what a change of the settings needs. */
export const swapping = (
  dependencies: SetupDependencies,
): { readonly change: SettingsChange; readonly current: RuntimeServices } => {
  const change = dependencies.settingsChange;
  if (change === undefined) {
    throw new Error('the setup routes need the settings holder (`settingsChange`)');
  }
  const current = change.holder.current();
  if (current === undefined) {
    throw new AppError({
      code: 'DATABASE_UNAVAILABLE',
      message: 'The server is starting. Try again shortly.',
    });
  }
  return { change, current };
};

const servingOf = (current: RuntimeServices): Serving => ({
  github: current.auth.github,
  email: current.mail !== undefined,
});

const wizardOf = (dependencies: SetupDependencies): WizardDependencies => ({
  database: dependencies.database,
  clock: dependencies.clock,
  change: swapping(dependencies).change,
});

/** `GET /setup/status` — whether the server is open to setup, and nothing else, to anybody. */
export const readSetupStatus = async ({
  database,
  config,
}: SetupDependencies): Promise<SetupStatus> => ({
  open: (await setupStatus(database)) === 'open',
  // The address the server is configured for (Ruling R35): the page compares it with its own before a
  // code is sent, since a claim from another origin is refused as cross-site.
  appUrl: config.APP_URL,
});

/**
 * `POST /setup/claim` — the code from the log. Accepted, the setup is bound to this browser: the
 * claim's token, once, in a cookie. The browser's id is the server's to make, never the caller's.
 */
export const claimTheSetup = async (
  dependencies: SetupDependencies,
  body: unknown,
): Promise<SetupAnswer<null>> => {
  const { code } = validated(SetupClaimRequest, body);
  const { claimToken } = await said(
    dependencies,
    async () =>
      await claimSetup(dependencies.database, code, crypto.randomUUID(), dependencies.clock),
  );
  return { ...NOTHING, setCookie: [setupCookie(claimToken, SETUP_CLAIM_IDLE_MS / 1000)] };
};

/** `GET /setup/state` — where the holder's setup stands, and what it needs to show. */
export const readSetupState = async (
  dependencies: SetupDependencies,
  request: Request,
): Promise<SetupAnswer<SetupState>> => {
  const holder = await theHolder(dependencies, request);
  const { session } = holder;
  const { current } = swapping(dependencies);
  const progress = await said(
    dependencies,
    async () =>
      await setupProgress(dependencies.database, session, servingOf(current), dependencies.clock),
  );
  const appUrl = dependencies.config.APP_URL;
  return answer(holder, {
    steps: progress.steps,
    appUrl,
    githubCallbackUrl: `${appUrl}${SIGN_IN_CALLBACK}`,
    settings: settingsView(current.settings),
    needsReentry: current.needsReentry,
    channels: progress.channels,
    admin: progress.admin,
    workspace:
      progress.workspace === null
        ? null
        : {
            id: progress.workspace.id,
            name: progress.workspace.name,
            slug: progress.workspace.slug,
          },
    canFinish: progress.finishProblems.length === 0,
    finishProblems: progress.finishProblems,
  });
};

/** `POST /setup/address` — the server's address seen and confirmed. */
export const confirmAddress = async (
  dependencies: SetupDependencies,
  request: Request,
  body: unknown,
): Promise<SetupAnswer<null>> => {
  const holder = await theHolder(dependencies, request);
  const { session } = holder;
  validated(SetupAddressRequest, body);
  await said(dependencies, async () => {
    await passStep(dependencies.database, session, 'address', dependencies.clock);
  });
  return answer(holder, null);
};

/**
 * `POST /setup/admin` — the administrator made, then signed in by the library with the password; only
 * the library's `Set-Cookie` is passed on. A sign-in that did not happen (a neighbour's guesses spent
 * this client's allowance) leaves the administrator made: `signedIn: false`, and the wizard says to sign
 * in with the password.
 */
export const makeAdministrator = async (
  dependencies: SetupDependencies,
  request: Request,
  body: unknown,
  clientAddress: string | undefined,
): Promise<SetupAnswer<SetupAdminAnswer>> => {
  const holder = await theHolder(dependencies, request);
  const { session } = holder;
  const input = validated(SetupAdminRequest, body);
  await said(dependencies, async () => {
    await createAdmin(
      { database: dependencies.database, auth: dependencies.auth, clock: dependencies.clock },
      session,
      input,
    );
  });
  const signedIn = await signInAdmin(dependencies.auth, {
    email: input.email,
    password: input.password,
    clientAddress: clientAddress ?? 'unknown',
  });
  // The body carries the session's raw token: read by nobody, sent to nobody.
  await signedIn.body?.cancel();
  return {
    status: 200,
    body: { signedIn: signedIn.ok },
    setCookie: [holder.refresh, ...(signedIn.ok ? signedIn.headers.getSetCookie() : [])],
  };
};

/** `POST /setup/policy` — who may make an account, saved and served at once. */
export const choosePolicyOf = async (
  dependencies: SetupDependencies,
  request: Request,
  body: unknown,
): Promise<SetupAnswer<null>> => {
  const holder = await theHolder(dependencies, request);
  const { session } = holder;
  const { signUp } = validated(SetupPolicyRequest, body);
  await said(dependencies, async () => {
    await choosePolicy(wizardOf(dependencies), session, signUp);
  });
  return answer(holder, null);
};

/**
 * `POST /setup/github` — GitHub's app tried; the try's outcome is the answer, `200` either way, and
 * kept only when it worked and `save` says so. `{ skip: true }` passes the step with nothing connected.
 */
export const tryGitHubApp = async (
  dependencies: SetupDependencies,
  request: Request,
  body: unknown,
): Promise<SetupAnswer<ProbeResult | null>> => {
  const holder = await theHolder(dependencies, request);
  const { session } = holder;
  const input = validated(SetupGitHubRequest, body);
  if ('skip' in input) {
    await said(dependencies, async () => {
      await passStep(dependencies.database, session, 'github', dependencies.clock);
    });
    return answer(holder, null);
  }
  const result = await said(
    dependencies,
    async () =>
      await tryGitHub(
        {
          ...wizardOf(dependencies),
          github: {
            // The platform's own `fetch`, to `GITHUB_URL`: never redirected (the type requires it).
            fetch: async (url, init) => await fetch(url, init),
            githubUrls: {
              web: dependencies.config.GITHUB_URL,
              api: dependencies.config.GITHUB_API_URL,
            },
          },
        },
        session,
        { clientId: input.clientId, clientSecret: input.clientSecret },
        input.save === true,
      ),
  );
  return answer(holder, result);
};

/**
 * `POST /setup/smtp` — the relay tried with the administrator's letter; the outcome is the answer, and
 * the relay kept only when it worked and `save` says so. `{ skip: true }` passes the step.
 */
export const tryMailRelay = async (
  dependencies: SetupDependencies,
  request: Request,
  body: unknown,
): Promise<SetupAnswer<ProbeResult | null>> => {
  const holder = await theHolder(dependencies, request);
  const { session } = holder;
  const input = validated(SetupSmtpRequest, body);
  if ('skip' in input) {
    await said(dependencies, async () => {
      await passStep(dependencies.database, session, 'email', dependencies.clock);
    });
    return answer(holder, null);
  }
  const result = await said(
    dependencies,
    async () =>
      await tryRelay(
        { ...wizardOf(dependencies), appUrl: dependencies.config.APP_URL },
        session,
        { smtpUrl: input.smtpUrl, from: input.from, allowPlaintext: input.allowPlaintext },
        input.locale,
        input.save === true,
      ),
  );
  return answer(holder, result);
};

/** `POST /setup/workspace` — the first workspace: `201` when made now, `200` with the one made before. */
export const makeTheFirstWorkspace = async (
  dependencies: SetupDependencies,
  request: Request,
  body: unknown,
): Promise<SetupAnswer<Workspace>> => {
  const holder = await theHolder(dependencies, request);
  const { session } = holder;
  const input = validated(CreateWorkspaceRequest, body);
  const { workspace, created } = await said(
    dependencies,
    async () => await makeFirstWorkspace(dependencies.database, session, input, dependencies.clock),
  );
  return answer(holder, workspace, created ? 201 : 200);
};

/** `POST /setup/invite` — the invitations sent, or skipped: they are the invitation routes' own. */
export const inviteDone = async (
  dependencies: SetupDependencies,
  request: Request,
): Promise<SetupAnswer<null>> => {
  const holder = await theHolder(dependencies, request);
  const { session } = holder;
  await said(dependencies, async () => {
    await passStep(dependencies.database, session, 'invite', dependencies.clock);
  });
  return answer(holder, null);
};

/** `POST /setup/finish` — the finish rule, then the door closed and the claim's cookie cleared. */
export const finishTheSetup = async (
  dependencies: SetupDependencies,
  request: Request,
): Promise<SetupAnswer<null>> => {
  const holder = await theHolder(dependencies, request);
  const { session } = holder;
  const { current } = swapping(dependencies);
  await said(dependencies, async () => {
    await finishSetup(dependencies.database, session, servingOf(current), dependencies.clock);
  });
  return { ...NOTHING, setCookie: [clearedSetupCookie()] };
};

/**
 * `POST /setup/verify` — the administrator's address link, followed in any browser, during the setup
 * or after it, for its day. Anything that is not a well-formed token is refused as a wrong one is,
 * before it is hashed: one answer.
 */
export const followAddressLink = async (
  { database, clock }: SetupDependencies,
  body: unknown,
): Promise<SetupVerifyAnswer> => {
  if (!Value.Check(SetupVerifyRequest, body)) throw linkNotFound();
  if ((await verifyAdminEmail(database, body.token, clock)) !== 'verified') throw linkNotFound();
  return { verified: true };
};
