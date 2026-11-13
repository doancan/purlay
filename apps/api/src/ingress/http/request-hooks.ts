/**
 * The hooks every request passes through, in the order the framework runs them: the module's deadline around the
 * whole of it, the request's scope and the edge's refusals at its first hook, the closed-route and rate checks before its
 * handler, and its line in the log after its answer. `createApp` attaches them; a failure is `error-hook.ts`'s.
 */
import { StatusMap, type Elysia, type HTTPHeaders } from 'elysia';
import { mapResponse as mapFrameworkResponse } from 'elysia/adapter/bun/handler';
import { ATTACHMENT_BYTES_MAX } from '@purlay/types';
import type { Composition } from '../../composition';
import { AppError } from '../../platform/errors';
import type { EntitlementPolicy } from '../../platform/module-kit/entitlement';
import { CORE_OWNER, NO_OWNER } from '../../platform/module-kit/ownership';
import {
  currentRequest,
  enterRequest,
  noteModule,
  type Logger,
  type RequestScope,
} from '../../platform/logging';
import { timedOut, withDeadline } from '../../platform/request-deadline';
import { clientRefusal, isOutsideClientPolicy } from './client-policy';
import { clientPolicyOf } from './client-info';
import { peerOf, type PeerSource } from './client-address';
import type { LeasedDependencies } from './dependencies';
import {
  JSON_BODY_MAX_BYTES,
  bodyRefusal,
  clientTooOldResponse,
  crossSiteResponse,
  edgeRefusalResponse,
  hasUnsupportedMediaType,
  inboundRequestId,
  isCrossSiteMutation,
  isUploadRequest,
  isWebhookRequest,
  pathWithoutSecret,
  unsupportedMediaTypeResponse,
  uploadRefusal,
  webhookRefusal,
} from './edge';
import { refusalFor } from './errors';
import { EDGE_ROUTE } from './metrics';
import type { httpLimits } from './rate-limit';
import type { RequestObservation } from './request-observation';
import { workspaceHttpAccess } from './workspace-access';

/** Paths asked every few seconds by a machine: their request lines are written at debug. */
const POLLED: ReadonlySet<string> = new Set(['/health', '/health/ready', '/metrics']);

/** The setup's paths, its client pages included: nothing under them is for a search engine. */
const SETUP_PATH = /^\/setup(?:\/|$)/;

type Wrap = Parameters<Elysia['wrap']>[0];

export interface RequestHooksInput {
  readonly dependencies: LeasedDependencies;
  readonly modules: Composition;
  readonly log: Logger;
  readonly entitlements: EntitlementPolicy;
  readonly edgeHeaders: Record<string, string>;
  readonly deadlineOf: (module: string) => number | undefined;
  readonly admit: ReturnType<typeof httpLimits>;
  readonly observation: RequestObservation;
  readonly activityLater: (work: () => Promise<void>) => void;
}

interface RequestContext {
  readonly request: Request;
  readonly set: { readonly headers: HTTPHeaders };
}

interface HandlerContext extends RequestContext {
  readonly server: PeerSource | null;
  readonly route: string;
}

interface ResponseContext {
  readonly request: Request;
  readonly path: string;
  readonly route: string;
  readonly set: { readonly status?: number | keyof typeof StatusMap };
  readonly responseValue: unknown;
}

interface MappingContext extends ResponseContext {
  readonly error?: unknown;
  readonly set: Parameters<typeof mapFrameworkResponse>[1];
}

export interface RequestHooks {
  readonly wrap: Wrap;
  readonly onRequest: (context: RequestContext) => Response | undefined;
  readonly onBeforeHandle: (context: HandlerContext) => Promise<void>;
  readonly onAfterResponse: (context: ResponseContext) => void;
  readonly onMapResponse: (context: MappingContext) => Response | undefined;
}

export const requestHooks = (input: RequestHooksInput): RequestHooks => {
  const { dependencies, modules, log, entitlements, edgeHeaders, deadlineOf, admit, observation } =
    input;
  const { moduleOfRoute, moduleField, observe, writtenPath } = observation;
  /**
   * A path of a module this process does not run is no route (`MODULES.md` §3): the `404` of any unknown path, with
   * the generic body and no word that says *disabled*, which would tell a caller who has not signed in which modules
   * this instance runs. Judged on the path as sent, which is the path the router matches (it does not decode `%6d`).
   */
  const closedRoute = (request: Request): boolean => modules.closed(new URL(request.url).pathname);
  /** What a request's own hooks know that the deadline, which wraps them all, needs to answer in their place. */
  const requestIds = new WeakMap<Request, string>();
  const requestScopes = new WeakMap<Request, RequestScope>();
  const deadlineSignals = new WeakMap<Request, AbortSignal>();
  /** The answer to a module's request that ran past its deadline: the envelope, with the headers the others carry. */
  const answerOverrun = (request: Request, module: string): Response => {
    const { status, body } = refusalFor('UNKNOWN', timedOut(), []);
    const { pathname } = new URL(request.url);
    log.warn('request ran past its deadline', {
      module,
      method: request.method,
      path: pathWithoutSecret(pathname),
    });
    return Response.json(body, {
      status,
      headers: { ...edgeHeaders, 'x-request-id': requestIds.get(request) ?? '' },
    });
  };

  /**
   * A module's request runs against its module's deadline, whatever it waits for (`platform/request-deadline.ts`, D-270).
   * `wrap` is the framework's own hook around the whole of a request, "do not use unless you know exactly what you are
   * doing" in its type's words: `docs/spikes/elysia.md` says what was measured, and `deadline.integration.test.ts` answers
   * a handler that never returns, over `handle` and over a started server, so an upgrade of the framework that changes it
   * fails there.
   */
  const wrap: Wrap = (fn, request) => {
    // The framework types what it wraps as a function that returns a function; it is the request's handler, which answers.
    const handle = fn as unknown as (...given: unknown[]) => Promise<Response> | Response;
    return async (...args: unknown[]): Promise<Response> => {
      const module = modules.owner.ofPath(new URL(request.url).pathname);
      const ms = module === undefined ? undefined : deadlineOf(module);
      if (module === undefined || ms === undefined) return await handle(...args);
      return await withDeadline(
        ms,
        async (signal) => {
          deadlineSignals.set(request, signal);
          return await handle(...args);
        },
        () => answerOverrun(request, module),
      );
    };
  };

  /**
   * Every request is one scope from its first hook: an id the response carries
   * back as `x-request-id`, and which every line written while serving it
   * carries too, however deep (D-71).
   */
  const onRequest = ({ request, set }: RequestContext): Response | undefined => {
    // An id from the edge is kept when well-formed, as a label only (#234).
    const requestId = inboundRequestId(request.headers);
    const scope: RequestScope = {
      requestId,
      startedAt: performance.now(),
      entitlements,
      workspaceAccess: workspaceHttpAccess(dependencies, request),
      ...(request.headers.has('x-purlay-active-workspace') ? { workspaceActivity: new Map() } : {}),
    };
    requestScopes.set(request, scope);
    enterRequest(scope);
    requestIds.set(request, requestId);
    // Before anything asks the library: every use of it in this request, and in what the request
    // leaves for after its answer, is of the instance current now (D-179 §4).
    dependencies.services?.pin();
    const headers = {
      ...edgeHeaders,
      'x-request-id': requestId,
      ...(SETUP_PATH.test(new URL(request.url).pathname) ? { 'x-robots-tag': 'noindex' } : {}),
    };
    Object.assign(set.headers, headers);
    // A request turned away here never reaches `onAfterResponse`, and it is the one the person who
    // holds its id most needs a line for: written now, as sent except under the library's, whose
    // paths can carry a token and are written as `/auth/*`.
    const turnedAway = (response: Response): Response => {
      const { pathname } = new URL(request.url);
      observe(request.method, EDGE_ROUTE, response.status);
      log.info('request', {
        method: request.method,
        path: pathname.startsWith('/auth/') ? '/auth/*' : pathWithoutSecret(pathname),
        status: response.status,
        ms: Math.round(performance.now() - (currentRequest()?.startedAt ?? performance.now())),
      });
      return response;
    };
    // Before the body is read or a session looked up (D-39 item 2).
    if (isCrossSiteMutation(request, dependencies.config.APP_URL)) {
      return turnedAway(crossSiteResponse(headers));
    }
    // An installed client this server no longer serves is told so, with what to get (D-186): before the
    // body is read or a session looked up, and not for the two things such a client needs in order to
    // learn it — liveness, and `GET /api/client` itself.
    if (!isOutsideClientPolicy(new URL(request.url).pathname)) {
      const tooOld = clientRefusal(
        request.headers.get('x-purlay-client'),
        clientPolicyOf(dependencies.config),
      );
      if (tooOld !== null) return turnedAway(clientTooOldResponse(tooOld, headers));
    }
    if (isUploadRequest(request)) {
      const refusal = uploadRefusal(request, ATTACHMENT_BYTES_MAX);
      if (refusal !== null) return turnedAway(edgeRefusalResponse(refusal, headers));
    } else if (isWebhookRequest(request) && !closedRoute(request)) {
      // A webhook of a module not run is no route: it falls to the body rules of any unknown path below.
      const refusal = webhookRefusal(request);
      if (refusal !== null) return turnedAway(edgeRefusalResponse(refusal, headers));
    } else {
      if (hasUnsupportedMediaType(request))
        return turnedAway(unsupportedMediaTypeResponse(headers));
      const tooMuch = bodyRefusal(request, JSON_BODY_MAX_BYTES);
      if (tooMuch !== null) return turnedAway(edgeRefusalResponse(tooMuch, headers));
    }
    return undefined;
  };

  // Before the handler, after the body is parsed: the body is already bounded by the
  // server (`edge.ts`), and a malformed one is a 400 whoever sends it, with no lookup.
  const onBeforeHandle = async ({ request, server, set, route }: HandlerContext): Promise<void> => {
    // The stopped modules are read again when the last read is older than the TTL (D-296): one query in two seconds, not one a request.
    await modules.suspension.fresh();
    if (closedRoute(request)) {
      throw new AppError({ code: 'ROUTE_NOT_FOUND', message: 'No such route.' });
    }
    // From here the request is its module's. The edge's limits and session reads below are the core's: they never touch
    // the leased database.
    const owner = moduleOfRoute(route);
    if (owner !== CORE_OWNER && owner !== NO_OWNER) noteModule(owner, deadlineSignals.get(request));
    const wait = await admit(request, peerOf(server, request));
    if (wait === undefined) return;
    set.headers['retry-after'] = String(wait);
    throw new AppError({ code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' });
  };

  const onAfterResponse = ({ request, path, route, set, responseValue }: ResponseContext): void => {
    const started = currentRequest()?.startedAt;
    // A balancer and the container's own health check poll these every few seconds, and a
    // scraper `/metrics`; at info they were most of the log. A probe that FAILS is not lost:
    // readiness writes the reason at warn.
    const write = POLLED.has(path) ? log.debug : log.info;
    // A handler that returns a `Response` (the library's routes) leaves `set.status` unset.
    const status =
      responseValue instanceof Response
        ? responseValue.status
        : typeof set.status === 'string'
          ? StatusMap[set.status]
          : (set.status ?? 200);
    observe(request.method, route, status);
    write('request', {
      method: request.method,
      path: writtenPath(route, path),
      ...moduleField(route),
      status,
      ...(started === undefined ? {} : { ms: Math.round(performance.now() - started) }),
    });
  };

  // Runs before the framework returns the response. Its delayed after-response hook is too late for
  // drain/settled to account for newly queued work, even though the response has already succeeded.
  const onMapResponse = ({
    request,
    set,
    responseValue,
    error,
  }: MappingContext): Response | undefined => {
    const status =
      responseValue instanceof Response
        ? responseValue.status
        : typeof set.status === 'string'
          ? StatusMap[set.status]
          : (set.status ?? 200);
    const pending = requestScopes.get(request)?.workspaceActivity;
    if (status < 400 && pending !== undefined) {
      const activities = [...pending.values()];
      input.activityLater(async (): Promise<void> => {
        for (const activity of activities) await activity();
      });
    }
    pending?.clear();
    requestScopes.delete(request);
    // Success keeps the framework's response path; its error handler replaces the answer with this return value.
    return error === undefined ? undefined : mapFrameworkResponse(responseValue, set, request);
  };

  return { wrap, onRequest, onBeforeHandle, onAfterResponse, onMapResponse };
};
