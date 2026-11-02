/**
 * A workspace's GitHub App installation and a person's own authorization (D-246 §1–2).
 *
 * - **Nothing without an App.** A server whose settings hold no App (D-179 §6) offers none of this: the status
 *   says `available: false`, and every route that would start something is `404 ROUTE_NOT_FOUND`.
 * - **One App, three kinds of token.** Sign-in stays the OAuth app, untouched. Everything shared is read with
 *   the installation's token. A person's own App user token exists only for their own writes.
 * - **An owner connects an installation**, and chooses its repositories on GitHub's own screen. The trip
 *   there and back carries a `state` of `platform/tokens.ts` — its digest alone kept, with the person and the
 *   workspace, for ten minutes, spent on return. GitHub's callback names an installation in its query, which
 *   anybody could write, so it is believed only when the code GitHub sent with it, redeemed, belongs to a person
 *   who can reach that installation (`GET /user/installations`), and that person is still the workspace's
 *   owner. The App must ask for authorization during installation for that code to come (`CONFIG.md`).
 * - **A person authorizes for themselves**: GitHub's authorization screen, with PKCE, the verifier sealed in
 *   the handshake. What comes back is their App user access token and, where the App's tokens expire, its
 *   refresh token — sealed by the one cipher with the row's id and the column bound in (D-39 §6), never
 *   logged, never returned, never used for anything every member sees (D-246 §2).
 * - **Revocation is believed from three places**: the person forgetting it here, GitHub saying the person
 *   revoked the App (`github_app_authorization`, `github-app-webhook.ts`), and GitHub answering `401` to the
 *   token. An installation removed on GitHub is let go everywhere it was connected; a suspended one is kept,
 *   said, and used for nothing.
 */
import type { Executor } from '@purlay/db';
import {
  GITHUB_APP_CALLBACK,
  type GitHubAppRedirect,
  type GitHubAppStatus,
  type GitHubCallbackOutcome,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { CredentialCipher } from '../../platform/crypto';
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import type { WorkspaceContext } from '../../platform/tenancy';
import { randomToken, tokenDigest } from '../../platform/tokens';
import { atomicallyOn } from '../../platform/transactions';
import { recordAudit } from '../audit/audit';
import type { GitHubAppSettings } from '../setup/settings';
import {
  GitHubRateLimited,
  GitHubUnauthorized,
  GitHubUnavailable,
  type GitHubAccount,
  type GitHubAppApi,
  type GitHubAppUrls,
  type UserTokens,
} from './github-app-api';
import { appJwt } from '../../platform/github-app-key';

/** How long a trip to GitHub and back may take: GitHub's own codes last ten minutes. */
const HANDSHAKE_TTL_MS = 10 * 60 * 1000;

export interface GitHubAppDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly cipher: CredentialCipher;
  readonly log: Logger;
  /** The App as the settings hold it now; unset is no App. */
  readonly app: GitHubAppSettings | undefined;
  readonly api: GitHubAppApi;
  readonly urls: GitHubAppUrls;
  /** `APP_URL`: what the callback address is built from. */
  readonly appUrl: string;
}

/** Each sealed column, bound with the row it is on, so a value moved to another row or column does not open. */
export const sealedIn = (column: 'access' | 'refresh', id: string): string =>
  `github_user_authorizations.${column}_token_encrypted:${id}`;

const VERIFIER_IN = 'github_app_handshakes.verifier_encrypted:';

const noApp = (): AppError =>
  new AppError({ code: 'ROUTE_NOT_FOUND', message: 'There is no GitHub App on this server.' });

/** The App, or the refusal that there is none: everything that starts a trip asks this first. */
export const requireApp = (app: GitHubAppSettings | undefined): GitHubAppSettings => {
  if (app === undefined) throw noApp();
  return app;
};

const mayConnect = (context: WorkspaceContext): void => {
  if (context.role !== 'owner') {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Only an owner connects the workspace’s GitHub App installation.',
    });
  }
};

const callbackUrl = (appUrl: string): string => `${appUrl}${GITHUB_APP_CALLBACK}`;

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** `GET /api/workspaces/:workspaceId/github-app` — what any member is shown. */
export const gitHubAppStatus = async (
  { database, app }: Pick<GitHubAppDependencies, 'database' | 'app'>,
  context: WorkspaceContext,
): Promise<GitHubAppStatus> => {
  if (app === undefined) return { available: false, installation: null, authorization: null };
  const installation = await database
    .selectFrom('github_app_installations')
    .select(['account_login', 'account_type', 'suspended_at', 'connected_at'])
    .where('workspace_id', '=', context.workspaceId)
    .executeTakeFirst();
  const authorization = await database
    .selectFrom('github_user_authorizations')
    .select('github_login')
    .where('user_id', '=', context.userId)
    .executeTakeFirst();
  return {
    available: true,
    installation:
      installation === undefined
        ? null
        : {
            accountLogin: installation.account_login,
            accountType: installation.account_type === 'User' ? 'User' : 'Organization',
            suspended: installation.suspended_at !== null,
            connectedAt: new Date(installation.connected_at).toISOString(),
          },
    authorization: authorization === undefined ? null : { login: authorization.github_login },
  };
};

/** A handshake made: its `state`, given once to GitHub's screen, and its digest kept. */
const handshake = async (
  { database, clock }: Pick<GitHubAppDependencies, 'database' | 'clock'>,
  row: {
    readonly userId: string;
    readonly workspaceId: string | null;
    readonly purpose: 'install' | 'authorize';
    readonly verifier: (digest: string) => Promise<string | null>;
    readonly returnTo: string | null;
  },
): Promise<string> => {
  const state = randomToken();
  const digest = await tokenDigest(state);
  await database
    .insertInto('github_app_handshakes')
    .values({
      state_digest: digest,
      user_id: row.userId,
      workspace_id: row.workspaceId,
      purpose: row.purpose,
      verifier_encrypted: await row.verifier(digest),
      return_to: row.returnTo,
      expires_at: new Date(clock.now().getTime() + HANDSHAKE_TTL_MS),
    })
    .execute();
  return state;
};

/** `POST /api/workspaces/:workspaceId/github-app/installation` — an owner, to GitHub's installation screen. */
export const startInstallation = async (
  dependencies: GitHubAppDependencies,
  context: WorkspaceContext,
): Promise<GitHubAppRedirect> => {
  const app = requireApp(dependencies.app);
  mayConnect(context);
  const state = await handshake(dependencies, {
    userId: context.userId,
    workspaceId: context.workspaceId,
    purpose: 'install',
    verifier: async () => await Promise.resolve(null),
    returnTo: null,
  });
  const url = new URL(`${dependencies.urls.web}/apps/${app.slug}/installations/new`);
  url.searchParams.set('state', state);
  return { url: url.toString() };
};

/** S256: the base64url SHA-256 of the verifier, unpadded (RFC 7636 §4.2). */
const challengeOf = async (verifier: string): Promise<string> =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString(
    'base64url',
  );

/** `POST /api/github-app/authorization` — the person, to GitHub's authorization screen, and back to `returnTo`. */
export const startAuthorization = async (
  dependencies: GitHubAppDependencies,
  userId: string,
  returnTo: string,
): Promise<GitHubAppRedirect> => {
  const app = requireApp(dependencies.app);
  // 43 characters of base64url: RFC 7636's minimum length, from 256 random bits.
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const state = await handshake(dependencies, {
    userId,
    workspaceId: null,
    purpose: 'authorize',
    verifier: async (digest) =>
      base64(await dependencies.cipher.seal(verifier, `${VERIFIER_IN}${digest}`)),
    returnTo,
  });
  const url = new URL(`${dependencies.urls.web}/login/oauth/authorize`);
  url.searchParams.set('client_id', app.clientId);
  url.searchParams.set('redirect_uri', callbackUrl(dependencies.appUrl));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await challengeOf(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString() };
};

/** A person's tokens kept, under their row's lock: one row per person, the seal bound to it. */
export const keepAuthorization = async (
  executor: Executor,
  { clock, cipher }: Pick<GitHubAppDependencies, 'clock' | 'cipher'>,
  userId: string,
  account: GitHubAccount,
  tokens: UserTokens,
): Promise<void> => {
  const existing = await executor
    .selectFrom('github_user_authorizations')
    .select('id')
    .where('user_id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  const id = existing?.id ?? crypto.randomUUID();
  const now = clock.now();
  const after = (seconds: number | null): Date | null =>
    seconds === null ? null : new Date(now.getTime() + seconds * 1000);
  const columns = {
    github_user_id: account.id,
    github_login: account.login,
    access_token_encrypted: base64(await cipher.seal(tokens.accessToken, sealedIn('access', id))),
    access_expires_at: after(tokens.accessExpiresIn),
    refresh_token_encrypted:
      tokens.refreshToken === null
        ? null
        : base64(await cipher.seal(tokens.refreshToken, sealedIn('refresh', id))),
    refresh_expires_at: tokens.refreshToken === null ? null : after(tokens.refreshExpiresIn),
    updated_at: now,
  };
  await executor
    .insertInto('github_user_authorizations')
    .values({ id, user_id: userId, created_at: now, ...columns })
    .onConflict((conflict) => conflict.column('user_id').doUpdateSet(columns))
    .execute();
};

/** `DELETE /api/github-app/authorization` — the person's own tokens forgotten here; nothing if none. */
export const forgetAuthorization = async (
  { database }: Pick<GitHubAppDependencies, 'database'>,
  userId: string,
): Promise<void> => {
  await database.deleteFrom('github_user_authorizations').where('user_id', '=', userId).execute();
};

/** `DELETE /api/workspaces/:workspaceId/github-app/installation` — an owner lets it go; nothing if none. */
export const disconnectInstallation = async (
  { database, clock }: Pick<GitHubAppDependencies, 'database' | 'clock'>,
  context: WorkspaceContext,
): Promise<void> => {
  mayConnect(context);
  await atomicallyOn(database)(async (transaction) => {
    const removed = await transaction
      .deleteFrom('github_app_installations')
      .where('workspace_id', '=', context.workspaceId)
      .returning(['id', 'account_login'])
      .executeTakeFirst();
    if (removed === undefined) return;
    await recordAudit(transaction, clock, {
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: 'integration.app_disconnected',
      targetType: 'integration',
      targetId: removed.id,
      metadata: { account: removed.account_login },
    });
  });
};

/** What GitHub's callback carries, as sent; any of it may be missing or made up. */
export interface CallbackQuery {
  readonly state: string | null;
  readonly code: string | null;
  readonly installationId: string | null;
  readonly error: string | null;
}

const STATE = /^[0-9a-f]{64}$/;
const INSTALLATION = /^[1-9][0-9]{0,18}$/;
const CODE = /^[\x21-\x7e]{1,256}$/;

interface Handshake {
  readonly user_id: string;
  readonly workspace_id: string | null;
  readonly purpose: string;
  readonly verifier_encrypted: string | null;
  readonly return_to: string | null;
}

/** Where a page is told what came of it: `?github=` on the path, never a code or a token. */
const told = (path: string, outcome: GitHubCallbackOutcome): string =>
  `${path}${path.includes('?') ? '&' : '?'}github=${outcome}`;

/**
 * `GET /api/github-app/callback` — where GitHub sends the browser back. Answers where to send it on: the
 * workspace's Integrations page after an installation, the page the person came from after an authorization,
 * each told the outcome; the start of the app when the trip is not one this server made.
 */
export const completeCallback = async (
  dependencies: GitHubAppDependencies,
  userId: string | null,
  query: CallbackQuery,
): Promise<string> => {
  const { database, clock, log } = dependencies;
  if (query.state === null || !STATE.test(query.state)) return told('/', 'expired');
  const digest = await tokenDigest(query.state);
  // Spent as it is read: a second return with the same state finds nothing.
  const trip: Handshake | undefined = await database
    .deleteFrom('github_app_handshakes')
    .where('state_digest', '=', digest)
    .where('expires_at', '>', clock.now())
    .returning(['user_id', 'workspace_id', 'purpose', 'verifier_encrypted', 'return_to'])
    .executeTakeFirst();
  if (trip === undefined) return told('/', 'expired');
  const back = await placeOf(database, trip);
  const outcome = await settle(dependencies, userId, trip, query, digest);
  log.info('github app callback', { purpose: trip.purpose, outcome });
  return told(back, outcome);
};

/** Where a trip returns to: the workspace's Integrations page, or the path the person came from. */
const placeOf = async (database: Executor, trip: Handshake): Promise<string> => {
  if (trip.purpose === 'authorize') return trip.return_to ?? '/';
  const workspace =
    trip.workspace_id === null
      ? undefined
      : await database
          .selectFrom('workspaces')
          .select('slug')
          .where('id', '=', trip.workspace_id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
  return workspace === undefined ? '/' : `/w/${workspace.slug}/settings/integrations`;
};

/** What the trip comes to; every failure of GitHub's is `unavailable`, and said in the log. */
const settle = async (
  dependencies: GitHubAppDependencies,
  userId: string | null,
  trip: Handshake,
  query: CallbackQuery,
  digest: string,
): Promise<GitHubCallbackOutcome> => {
  const app = dependencies.app;
  if (app === undefined) return 'unavailable';
  // The browser that comes back must be the person who left: a link to the callback sent to somebody else
  // connects nothing of theirs.
  if (userId !== trip.user_id) return 'not-yours';
  // The person pressed Cancel, or the App does not ask for authorization during installation.
  if (query.error !== null || query.code === null || !CODE.test(query.code)) return 'refused';
  try {
    const verifier =
      trip.verifier_encrypted === null
        ? undefined
        : await dependencies.cipher.open(
            Buffer.from(trip.verifier_encrypted, 'base64'),
            `${VERIFIER_IN}${digest}`,
          );
    const tokens = await dependencies.api.exchangeCode(app, {
      code: query.code,
      redirectUri: callbackUrl(dependencies.appUrl),
      ...(verifier === undefined ? {} : { verifier }),
    });
    if (tokens === 'refused') return 'refused';
    const account = await dependencies.api.user(tokens.accessToken);
    if (trip.purpose === 'authorize') {
      await atomicallyOn(dependencies.database)(async (transaction) => {
        await keepAuthorization(transaction, dependencies, trip.user_id, account, tokens);
      });
      return 'authorized';
    }
    return await connect(dependencies, app, trip, query, tokens);
  } catch (error) {
    if (
      error instanceof GitHubUnavailable ||
      error instanceof GitHubRateLimited ||
      error instanceof GitHubUnauthorized
    ) {
      dependencies.log.warn('github app callback: GitHub did not answer', {
        purpose: trip.purpose,
        error: error.message,
      });
      return 'unavailable';
    }
    throw error;
  }
};

/**
 * An installation believed and kept for the workspace. The code proves who came back and what they can reach;
 * its token is dropped, not kept: writing as oneself is a separate, explicit opt-in (D-246 §2), and a shared
 * thing is read with the installation, never with a person's token.
 */
const connect = async (
  dependencies: GitHubAppDependencies,
  app: GitHubAppSettings,
  trip: Handshake,
  query: CallbackQuery,
  tokens: UserTokens,
): Promise<GitHubCallbackOutcome> => {
  const { database, clock, api } = dependencies;
  const workspaceId = trip.workspace_id;
  if (workspaceId === null || query.installationId === null) return 'refused';
  if (!INSTALLATION.test(query.installationId)) return 'refused';
  const installationId = Number(query.installationId);
  // The query names an installation; the code proves who came back, and GitHub says what they can reach.
  if (!(await api.userInstallationIds(tokens.accessToken)).includes(installationId)) {
    return 'not-yours';
  }
  const installation = await api.installation(
    appJwt(app.clientId, app.privateKey, clock.now()),
    installationId,
  );
  if (installation === 'missing') return 'not-yours';
  return await atomicallyOn(database)(async (transaction) => {
    // Still the workspace's owner, and the workspace still there, as the installation is kept.
    const owner = await transaction
      .selectFrom('workspace_members')
      .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
      .select('workspace_members.role')
      .where('workspace_members.workspace_id', '=', workspaceId)
      .where('workspace_members.user_id', '=', trip.user_id)
      .where('workspaces.deleted_at', 'is', null)
      .forShare()
      .executeTakeFirst();
    if (owner?.role !== 'owner') return 'not-yours';
    const now = clock.now();
    const columns = {
      installation_id: installation.id,
      account_login: installation.accountLogin,
      account_type: installation.accountType,
      suspended_at: installation.suspended ? now : null,
      connected_by: trip.user_id,
      connected_at: now,
    };
    const kept = await transaction
      .insertInto('github_app_installations')
      .values({ id: crypto.randomUUID(), workspace_id: workspaceId, ...columns })
      .onConflict((conflict) => conflict.column('workspace_id').doUpdateSet(columns))
      .returning('id')
      .executeTakeFirstOrThrow();
    await recordAudit(transaction, clock, {
      workspaceId,
      actorUserId: trip.user_id,
      action: 'integration.app_connected',
      targetType: 'integration',
      targetId: kept.id,
      metadata: { account: installation.accountLogin },
    });
    return 'connected';
  });
};
