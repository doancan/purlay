/**
 * The HTTP surface.
 *
 * Ingress validates, delegates and serialises. It holds no business rule: the
 * layer below never sees an HTTP type, and lint enforces that direction
 * (`ARCHITECTURE.md` §4).
 *
 * **Dependencies are arguments, and they arrived with the first route that needed
 * them.** Until sign-in existed the application took none, which is the rule the
 * configuration loader follows: a thing is wired when the feature that needs it
 * is built (D-57). `/health` still touches none of them, which is what keeps
 * liveness answerable while the database is down.
 *
 * **What it returns is the surface the caller uses, not the framework's type.**
 * Left to inference that is the accumulated type of every route, which under
 * `composite` lands in a committed `.d.ts` growing with routes × error branches
 * — 5 KB for six trivial routes when it was measured (`docs/spikes/elysia.md`).
 * Annotating it as the bare `Elysia` does not compile either: the type is
 * invariant in its routes, so a widened annotation is not assignable to itself
 * with one route added. Naming the two methods the composition root and the
 * tests actually call answers both, and leaves nothing above this file depending
 * on which framework is underneath.
 */
import { Elysia } from 'elysia';
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import type { Config } from '../../platform/config';
import type { GitHubClient } from '../../modules/auth/github';
import { completeSignIn, signOut, signOutEverywhere, startSignIn, type AuthResponse } from './auth';
import { refusalFor } from './errors';
import {
  createMyWorkspace,
  listMyWorkspaces,
  listWorkspaceMembers,
  readWorkspace,
} from './workspaces';
import { createWorkspaceChannel, joinPublicChannel, listChannels, readChannel } from './channels';
import { postMessage, readHistory } from './messages';

export interface Dependencies {
  readonly config: Config;
  /** A `Kysely` or a `Transaction` — indistinguishable here, which is the point (D-46). */
  readonly database: Executor;
  readonly clock: Clock;
  readonly github: GitHubClient;
}

/**
 * Everything outside ingress may do with the application.
 *
 * `handle` is what a test drives — a real `Request` in, a real `Response` out,
 * with no socket and no port. That is why the tests below are not integration
 * tests: they exercise the actual routing and the actual error handler.
 */
export interface HttpApplication {
  readonly handle: (request: Request) => Promise<Response>;
  readonly listen: (port: number) => void;
}

/** Liveness. Deliberately touches nothing. */
const HEALTH = { status: 'ok' } as const;

/**
 * The only place a handler's decision becomes a framework response.
 *
 * The handlers in `auth.ts` know nothing about the framework, so this is where a
 * cookie and a redirect are applied — once, rather than four times.
 */
const respond = (
  set: { status?: number | string; headers: Record<string, string | number | undefined> },
  result: AuthResponse,
): string => {
  set.headers['set-cookie'] = result.setCookie;
  if (result.location === undefined) {
    set.status = 204;
    return '';
  }
  set.status = 302;
  set.headers['location'] = result.location;
  return '';
};

export const createApp = (dependencies: Dependencies): HttpApplication => {
  const app = new Elysia()
    /**
     * One error handler for the whole surface, so a status is decided in exactly
     * one place. `set.status` rather than a thrown response: a second way to
     * choose a status is a second place for two of them to disagree.
     */
    .onError(({ code, error, set }) => {
      const issues = 'all' in error && Array.isArray(error.all) ? error.all : [];
      const refusal = refusalFor(code, error, issues);
      set.status = refusal.status;
      return refusal.body;
    })
    .get('/health', () => HEALTH)

    .get('/auth/github', async ({ set }) => respond(set, await startSignIn(dependencies)))
    .get('/auth/github/callback', async ({ request, set }) =>
      respond(set, await completeSignIn(dependencies, request)),
    )
    .post('/auth/logout', async ({ request, set }) =>
      respond(set, await signOut(dependencies, request)),
    )
    .post('/auth/logout-all', async ({ request, set }) =>
      respond(set, await signOutEverywhere(dependencies, request)),
    )

    .get('/api/workspaces', async ({ request }) => await listMyWorkspaces(dependencies, request))
    .post('/api/workspaces', async ({ request, body, set }) => {
      set.status = 201;
      return await createMyWorkspace(dependencies, request, body);
    })
    .get(
      '/api/workspaces/:workspaceId',
      async ({ request, params }) => await readWorkspace(dependencies, request, params.workspaceId),
    )
    .get(
      '/api/workspaces/:workspaceId/members',
      async ({ request, params }) =>
        await listWorkspaceMembers(dependencies, request, params.workspaceId),
    )

    .get(
      '/api/workspaces/:workspaceId/channels',
      async ({ request, params }) => await listChannels(dependencies, request, params.workspaceId),
    )
    .post('/api/workspaces/:workspaceId/channels', async ({ request, params, body, set }) => {
      set.status = 201;
      return await createWorkspaceChannel(dependencies, request, params.workspaceId, body);
    })
    .get(
      '/api/channels/:channelId',
      async ({ request, params }) => await readChannel(dependencies, request, params.channelId),
    )
    .post(
      '/api/channels/:channelId/join',
      async ({ request, params }) =>
        await joinPublicChannel(dependencies, request, params.channelId),
    )

    .get(
      '/api/channels/:channelId/messages',
      async ({ request, params }) => await readHistory(dependencies, request, params.channelId),
    )
    .post('/api/channels/:channelId/messages', async ({ request, params, body, set }) => {
      set.status = 201;
      return await postMessage(dependencies, request, params.channelId, body);
    });

  return app;
};
