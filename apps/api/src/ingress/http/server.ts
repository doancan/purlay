/**
 * Administration → Server over HTTP (D-179 §4.8, `API.md` §2 `/api/server/*`): the operator's settings
 * changed in the browser after the setup — as functions that take a request and say what the response
 * is, like `setup.ts`, whose way of saying a refusal (`said`) is reused.
 *
 * - **One guard, first.** Every route takes the request's own session through `requireServerAdmin`
 *   before it reads the body or anything else; what the guard mints is what the module's functions and
 *   the probes take. Everybody who is not the server's administrator — signed out, a member, a
 *   workspace's owner — is the one answer, `404 ROUTE_NOT_FOUND`.
 * - **What the edge does first** (`app.ts`, `edge.ts`, `rate-limit.ts`): a cross-site write refused, a
 *   body that is not JSON or too long refused, a limit per client charged to every path under
 *   `/api/server` — before the guard runs, so a stranger cannot spend its work. Every answer is
 *   `no-store`.
 * - **Nothing secret comes back or goes to the log.** The secret is `clientSecret`, the relay's address
 *   `smtpUrl`: names the logger never writes. The view carries `{ set }` and a relay's host.
 */
import {
  ServerCreatorsRequest,
  ServerDisconnectRequest,
  OIDC_NAME_MAX,
  ServerGitHubRequest,
  ServerOidcRequest,
  ServerPolicyRequest,
  ServerSmtpRequest,
  type ProbeResult,
  type ServerSettingsAnswer,
} from '@purlay/types';
import { isGitHubLogin } from '../../modules/setup/settings';
import {
  changeCreators,
  changePolicy,
  connectGitHub,
  connectOidc,
  connectRelay,
  disconnect,
  serverSettingsOf,
  ServerChangeRefused,
  type ServerAdminDependencies,
} from '../../modules/setup/server-admin';
import { requireServerAdmin, type ServerAdminSession } from '../../modules/setup/setup';
import { AppError } from '../../platform/errors';
import { oidcIssuerProblem, oidcNameProblem } from '../../platform/oidc-address';
import { refusedField, said, swapping, type SetupDependencies } from './setup';
import { validated } from './validate';

/** What the routes need: the setup's own dependencies — the pool, the clock, the holder's swap. */
export type ServerDependencies = SetupDependencies;

/** The guard, then the work, a refusal of the module said as the contract says it. */
const asAdmin = async <T>(
  dependencies: ServerDependencies,
  request: Request,
  work: (admin: ServerAdminSession, change: ServerAdminDependencies) => Promise<T>,
): Promise<T> => {
  const admin = await requireServerAdmin(dependencies.auth, dependencies.database, request.headers);
  const module: ServerAdminDependencies = {
    database: dependencies.database,
    clock: dependencies.clock,
    change: swapping(dependencies).change,
  };
  return await said(dependencies, async () => {
    try {
      return await work(admin, module);
    } catch (error) {
      if (error instanceof ServerChangeRefused) {
        throw new AppError({
          code: 'SERVER_CHANGE_REFUSED',
          message: error.message,
          details: { reason: error.reason },
        });
      }
      throw error;
    }
  });
};

/** `GET /api/server/settings` — what the page shows, and never a secret. */
export const readServerSettings = async (
  dependencies: ServerDependencies,
  request: Request,
): Promise<ServerSettingsAnswer> =>
  await asAdmin(dependencies, request, async (admin, module) => {
    return await serverSettingsOf(
      module,
      admin,
      swapping(dependencies).current,
      dependencies.config.APP_URL,
    );
  });

/** `POST /api/server/github` — the app tried; `200` with the outcome either way; kept only if it worked. */
export const connectGitHubApp = async (
  dependencies: ServerDependencies,
  request: Request,
  body: unknown,
): Promise<ProbeResult> =>
  await asAdmin(dependencies, request, async (admin, module) => {
    const input = validated(ServerGitHubRequest, body);
    return await connectGitHub(
      {
        ...module,
        github: {
          // The platform's own `fetch`, to `GITHUB_URL`: never redirected (the type requires it).
          fetch: async (url, init) => await fetch(url, init),
          githubUrls: {
            web: dependencies.config.GITHUB_URL,
            api: dependencies.config.GITHUB_API_URL,
          },
        },
      },
      admin,
      { clientId: input.clientId, clientSecret: input.clientSecret },
    );
  });

/**
 * `POST /api/server/oidc` — the single sign-on provider tried (its discovery, its keys, the client); `200` with
 * the outcome either way, and kept only if it worked (D-200 §2). An issuer or a name the settings could not hold
 * is refused as input before anything is called.
 */
export const connectOidcProvider = async (
  dependencies: ServerDependencies,
  request: Request,
  body: unknown,
): Promise<ProbeResult> =>
  await asAdmin(dependencies, request, async (admin, module) => {
    const input = validated(ServerOidcRequest, body);
    const issuerProblem = oidcIssuerProblem(input.issuer);
    if (issuerProblem !== undefined) {
      throw refusedField('That cannot be tried.', 'issuer', issuerProblem);
    }
    const name = input.name === undefined || input.name === '' ? undefined : input.name;
    const nameProblem = name === undefined ? undefined : oidcNameProblem(name, OIDC_NAME_MAX);
    if (nameProblem !== undefined) throw refusedField('That cannot be tried.', 'name', nameProblem);
    return await connectOidc(
      {
        ...module,
        oidc: {
          // The platform's own `fetch`, to the issuer's addresses: never redirected (the type requires it).
          fetch: async (url, init) => await fetch(url, init),
          appUrl: dependencies.config.APP_URL,
          log: dependencies.log,
        },
      },
      admin,
      { issuer: input.issuer, clientId: input.clientId, clientSecret: input.clientSecret, name },
    );
  });

/** `POST /api/server/smtp` — the relay tried with a test letter to the caller; kept only if it worked. */
export const connectMailRelay = async (
  dependencies: ServerDependencies,
  request: Request,
  body: unknown,
): Promise<ProbeResult> =>
  await asAdmin(dependencies, request, async (admin, module) => {
    const input = validated(ServerSmtpRequest, body);
    return await connectRelay({ ...module, appUrl: dependencies.config.APP_URL }, admin, {
      smtpUrl: input.smtpUrl,
      from: input.from,
      allowPlaintext: input.allowPlaintext,
    });
  });

/** The optional body of a disconnect: nothing, or `{ confirmLastChannel }`. */
const confirmationIn = async (request: Request): Promise<boolean> => {
  const text = await request.text();
  if (text === '') return false;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'The request did not match the contract.',
      details: { fields: { body: 'is not JSON' } },
    });
  }
  return validated(ServerDisconnectRequest, body).confirmLastChannel === true;
};

/** `DELETE /api/server/github`, `/smtp` and `/oidc` — one way in disconnected; `204`. */
export const disconnectChannel = async (
  dependencies: ServerDependencies,
  request: Request,
  channel: 'github' | 'smtp' | 'oidc',
): Promise<void> => {
  await asAdmin(dependencies, request, async (admin, module) => {
    const confirmed = await confirmationIn(request);
    await disconnect(module, admin, channel, swapping(dependencies).current, confirmed);
  });
};

/** `POST /api/server/policy` — who may make an account; `204`. */
export const changeSignUpPolicy = async (
  dependencies: ServerDependencies,
  request: Request,
  body: unknown,
): Promise<void> => {
  await asAdmin(dependencies, request, async (admin, module) => {
    await changePolicy(module, admin, validated(ServerPolicyRequest, body).signUp);
  });
};

/** `POST /api/server/creators` — who may make a workspace; `204`. */
export const changeWorkspaceCreators = async (
  dependencies: ServerDependencies,
  request: Request,
  body: unknown,
): Promise<void> => {
  await asAdmin(dependencies, request, async (admin, module) => {
    const { workspaceCreators } = validated(ServerCreatorsRequest, body);
    if (workspaceCreators.kind === 'listed') {
      const logins = workspaceCreators.logins.map((login) => login.trim().toLowerCase());
      if (!logins.every(isGitHubLogin)) {
        throw refusedField(
          'That cannot be saved.',
          'workspaceCreators',
          'is one or more GitHub logins',
        );
      }
      await changeCreators(module, admin, { kind: 'listed', logins });
      return;
    }
    await changeCreators(module, admin, workspaceCreators);
  });
};
