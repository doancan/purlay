/**
 * The GitHub App over HTTP (D-246, `API.md` §7): a workspace's installation, a person's own authorization,
 * GitHub's callback and the App's deliveries. Each route validates, calls one function of
 * `features/chat/integrations/github-app*.ts`, and answers; the App is the settings' as this request pinned them.
 */
import { Elysia, type AnyElysia } from 'elysia';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import type { GitHubWiring } from './wiring';
import { limitKeyFor } from '../../../platform/client-key';
import { clientAddress, peerOf } from '../../../ingress/http/client-address';
import {
  GitHubAuthorizationRequest,
  type GitHubAppRedirect,
  type GitHubAppStatus,
} from '@purlay/types';
import type { Auth } from '../../../modules/auth/better-auth';
import {
  completeCallback,
  disconnectInstallation,
  forgetAuthorization,
  gitHubAppStatus,
  startAuthorization,
  startInstallation,
  type GitHubAppDependencies,
} from '../integrations/github-app';
import {
  receiveAppDelivery,
  requireAppAddress,
  type AppOutcome,
} from '../integrations/github-app-webhook';
import { AppError } from '../../../platform/errors';
import type { EventBus } from '../../../platform/events';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { requireSession } from '../../../ingress/http/session';
import { validated } from '../../../ingress/http/validate';
import { DELIVERIES_AT_ONCE, DELIVERY_READ_MS, readWithin } from './webhooks';

export interface GitHubAppRouteDependencies extends GitHubAppDependencies {
  readonly auth: Auth;
}

/** `GET /api/workspaces/:workspaceId/github-app` — any member. */
const readGitHubAppStatus = async (
  dependencies: GitHubAppRouteDependencies,
  request: Request,
  workspaceId: string,
): Promise<GitHubAppStatus> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(dependencies.database, userId, workspaceId);
  return await gitHubAppStatus(dependencies, context);
};

/** `POST /api/workspaces/:workspaceId/github-app/installation` — an owner, to GitHub's installation screen. */
const beginInstallation = async (
  dependencies: GitHubAppRouteDependencies,
  request: Request,
  workspaceId: string,
): Promise<GitHubAppRedirect> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(dependencies.database, userId, workspaceId);
  return await startInstallation(dependencies, context);
};

/** `DELETE /api/workspaces/:workspaceId/github-app/installation` — an owner lets it go; `204`. */
const endInstallation = async (
  dependencies: GitHubAppRouteDependencies,
  request: Request,
  workspaceId: string,
): Promise<void> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(dependencies.database, userId, workspaceId);
  await disconnectInstallation(dependencies, context);
};

/** `POST /api/github-app/authorization` — the person, to GitHub's authorization screen. */
const beginAuthorization = async (
  dependencies: GitHubAppRouteDependencies,
  request: Request,
  body: unknown,
): Promise<GitHubAppRedirect> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const { returnTo } = validated(GitHubAuthorizationRequest, body);
  return await startAuthorization(dependencies, userId, returnTo);
};

/** `DELETE /api/github-app/authorization` — the person's own tokens forgotten; `204`. */
const endAuthorization = async (
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
const githubAppCallback = async (
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
  /** What a delivery that changes what a thread shows tells the rooms through. */
  readonly bus: EventBus;
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

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const githubAppRoutes = (
  context: ModuleRouteDependencies,
  wiring: GitHubWiring,
): AnyElysia =>
  new Elysia()
    .get(
      '/api/workspaces/:workspaceId/github-app',
      async ({ request, params }) =>
        await readGitHubAppStatus(wiring.githubApp(), request, params.workspaceId),
    )
    .post(
      '/api/workspaces/:workspaceId/github-app/installation',
      async ({ request, params }) =>
        await beginInstallation(wiring.githubApp(), request, params.workspaceId),
    )
    .delete(
      '/api/workspaces/:workspaceId/github-app/installation',
      async ({ request, params, set }) => {
        await endInstallation(wiring.githubApp(), request, params.workspaceId);
        set.status = 204;
        return null;
      },
    )
    .post(
      '/api/github-app/authorization',
      async ({ request, body }) => await beginAuthorization(wiring.githubApp(), request, body),
    )
    .delete('/api/github-app/authorization', async ({ request, set }) => {
      await endAuthorization(wiring.githubApp(), request);
      set.status = 204;
      return null;
    })
    .get('/api/github-app/callback', async ({ request, set }) => {
      set.status = 302;
      set.headers.location = await githubAppCallback(wiring.githubApp(), request);
      set.headers['cache-control'] = 'no-store';
      return '';
    })
    .post(
      '/api/webhooks/github-app',
      async ({ request, server }) => {
        const outcome = await receiveAppWebhook(
          {
            ...wiring.githubIssues(),
            mayKnock: async (address) => await wiring.knocks.consume(address),
            inFlight: wiring.delivering,
            deadline: async (ms) => {
              await Bun.sleep(ms);
            },
          },
          request,
          limitKeyFor(
            clientAddress(peerOf(server, request), request.headers, context.config.TRUST_PROXY),
          ),
        );
        return { outcome };
      },
      // The signature is over the bytes as sent, so the handler reads them, unparsed (D-134 §4).
      { parse: 'none' },
    );
