/**
 * The GitHub App over HTTP (D-246, `API.md` §7): a workspace's installation, a person's own authorization,
 * GitHub's callback and the App's deliveries. Each route validates, calls one function of
 * `modules/integrations/github-app*.ts`, and answers; the App is the settings' as this request pinned them.
 */
import {
  GitHubAuthorizationRequest,
  type GitHubAppRedirect,
  type GitHubAppStatus,
} from '@purlay/types';
import type { Auth } from '../../modules/auth/better-auth';
import {
  completeCallback,
  disconnectInstallation,
  forgetAuthorization,
  gitHubAppStatus,
  startAuthorization,
  startInstallation,
  type GitHubAppDependencies,
} from '../../modules/integrations/github-app';
import {
  receiveAppDelivery,
  requireAppAddress,
  type AppOutcome,
} from '../../modules/integrations/github-app-webhook';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { requireSession } from './session';
import { validated } from './validate';
import { DELIVERIES_AT_ONCE, DELIVERY_READ_MS, readWithin } from './webhooks';

export interface GitHubAppRouteDependencies extends GitHubAppDependencies {
  readonly auth: Auth;
}

/** `GET /api/workspaces/:workspaceId/github-app` — any member. */
export const readGitHubAppStatus = async (
  dependencies: GitHubAppRouteDependencies,
  request: Request,
  workspaceId: string,
): Promise<GitHubAppStatus> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(dependencies.database, userId, workspaceId);
  return await gitHubAppStatus(dependencies, context);
};

/** `POST /api/workspaces/:workspaceId/github-app/installation` — an owner, to GitHub's installation screen. */
export const beginInstallation = async (
  dependencies: GitHubAppRouteDependencies,
  request: Request,
  workspaceId: string,
): Promise<GitHubAppRedirect> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(dependencies.database, userId, workspaceId);
  return await startInstallation(dependencies, context);
};

/** `DELETE /api/workspaces/:workspaceId/github-app/installation` — an owner lets it go; `204`. */
export const endInstallation = async (
  dependencies: GitHubAppRouteDependencies,
  request: Request,
  workspaceId: string,
): Promise<void> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(dependencies.database, userId, workspaceId);
  await disconnectInstallation(dependencies, context);
};

/** `POST /api/github-app/authorization` — the person, to GitHub's authorization screen. */
export const beginAuthorization = async (
  dependencies: GitHubAppRouteDependencies,
  request: Request,
  body: unknown,
): Promise<GitHubAppRedirect> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const { returnTo } = validated(GitHubAuthorizationRequest, body);
  return await startAuthorization(dependencies, userId, returnTo);
};

/** `DELETE /api/github-app/authorization` — the person's own tokens forgotten; `204`. */
export const endAuthorization = async (
  dependencies: GitHubAppRouteDependencies,
  request: Request,
): Promise<void> => {
  const { userId } = await requireSession(dependencies.auth, request);
  await forgetAuthorization(dependencies, userId);
};

/**
 * `GET /api/github-app/callback` — a browser GitHub sent back: answered with where to go on, never JSON. A
 * browser signed out, or owing two-step verification, is somebody the trip cannot be finished for.
 */
export const githubAppCallback = async (
  dependencies: GitHubAppRouteDependencies,
  request: Request,
): Promise<string> => {
  let userId: string | null = null;
  try {
    ({ userId } = await requireSession(dependencies.auth, request));
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
  }
  const query = new URL(request.url).searchParams;
  return await completeCallback(dependencies, userId, {
    state: query.get('state'),
    code: query.get('code'),
    installationId: query.get('installation_id'),
    error: query.get('error'),
  });
};

export interface AppWebhookRouteDependencies extends GitHubAppRouteDependencies {
  /** Whether this address may knock once more: the feeds' bucket, before anything is looked at. */
  readonly mayKnock: (address: string) => Promise<boolean>;
  /** This node's count of deliveries being read, shared with the feeds' address. */
  readonly inFlight: { count: number };
  readonly deadline: (ms: number) => Promise<void>;
}

const busy = (): AppError =>
  new AppError({ code: 'RATE_LIMITED', message: 'Too many deliveries. Slow down.' });

/**
 * `POST /api/webhooks/github-app` — the App's deliveries. As a feed's address (`webhooks.ts`): the address
 * spends its bucket, a node reads a few at once, each within a deadline; and without an App there is no such
 * address.
 */
export const receiveAppWebhook = async (
  dependencies: AppWebhookRouteDependencies,
  request: Request,
  address: string,
): Promise<AppOutcome> => {
  const { mayKnock, inFlight, log, deadline } = dependencies;
  if (!(await mayKnock(address))) {
    log.warn('github app delivery', { outcome: 'knocked_too_often' });
    throw busy();
  }
  requireAppAddress(dependencies.app);
  if (inFlight.count >= DELIVERIES_AT_ONCE) {
    log.warn('github app delivery', { outcome: 'node_busy' });
    throw busy();
  }
  inFlight.count += 1;
  try {
    const body = await readWithin(request, deadline(DELIVERY_READ_MS));
    return await receiveAppDelivery(dependencies, {
      signature: request.headers.get('x-hub-signature-256'),
      event: request.headers.get('x-github-event'),
      deliveryId: request.headers.get('x-github-delivery'),
      body,
    });
  } finally {
    inFlight.count -= 1;
  }
};
