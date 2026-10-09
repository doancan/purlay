/**
 * Which endpoints sit behind the tenant boundary, and how a test crosses each one.
 *
 * `ARCHITECTURE.md` §10 makes a cross-tenant test mandatory on every
 * workspace-scoped endpoint, and the rule most likely to erode is the one that
 * must hold on every endpoint forever (D-21). Remembering to write the test is
 * the discipline model D-21 rejects, so the list of endpoints is not kept here:
 * it is read from `API.md`, and every documented `/api/` endpoint the
 * application serves must appear below — in `CROSS_TENANT` with a case, or in
 * `UNSCOPED` with the reason it has no tenant to cross. Neither is a failing
 * build (`cross-tenant.test.ts`). (D-63)
 *
 * A case names only what cannot be derived. The path is the documented one with
 * its parameters filled in, so a case cannot test a route other than the one it
 * is keyed by.
 *
 * **Each case also places its endpoint on the second axis** — channel
 * visibility, inside one workspace (D-34). The field is required, so an endpoint
 * cannot be added without deciding it, and the ones that name a channel cannot
 * opt out (`cross-tenant.test.ts`). The crossings are in
 * `channel-visibility.integration.test.ts`. (D-64)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { messageId, type ErrorCode } from '@purlay/types';

export interface DocumentedEndpoint {
  readonly method: string;
  readonly path: string;
}

/** `GET /api/workspaces/:workspaceId` — how an endpoint is named in both tables below. */
export const endpointKey = (endpoint: DocumentedEndpoint): string =>
  `${endpoint.method} ${endpoint.path}`;

/** A row of an `API.md` endpoint table: phase marker, method, path. */
const ROW = /^\|\s*[^|]*\|\s*`(GET|POST|PUT|PATCH|DELETE)`\s*\|\s*`(\/api\/[^`]+)`\s*\|/;

/**
 * `docs/API.md`, found from this file rather than from wherever the process was
 * started: `bun test` from a subdirectory, or a script run with another working
 * directory, must read the same document or the list silently shrinks to nothing.
 */
const API_DOCUMENT = fileURLToPath(new URL('../../../../docs/API.md', import.meta.url));

/** Every `/api/` endpoint `API.md` documents, in every phase. */
export const documentedEndpoints = (): readonly DocumentedEndpoint[] =>
  readFileSync(API_DOCUMENT, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const match = ROW.exec(line);
      return match?.[1] === undefined || match[2] === undefined
        ? []
        : [{ method: match[1], path: match[2] }];
    });

/** The ids a crossing is made with: the owner's real ones, or ones that never existed. */
export interface Ids {
  readonly workspaceId: string;
  readonly channelId: string;
}

/**
 * The documented path with its parameters filled in.
 *
 * A parameter this does not know is an error rather than a path left with a
 * colon in it: that request would be a `404` for the wrong reason, and the case
 * would pass while proving nothing.
 */
export const pathFor = (path: string, ids: Ids): string =>
  path.replace(/:(\w+)/g, (_whole, name: string) => {
    if (name === 'workspaceId') return ids.workspaceId;
    if (name === 'channelId') return ids.channelId;
    throw new Error(`no id for \`:${name}\` in ${path} — teach \`pathFor\` and \`Ids\` about it`);
  });

/**
 * Where an endpoint sits on the channel-visibility axis.
 *
 * - `channel`: it names one channel, and a workspace member who cannot see that
 *   channel is told it does not exist.
 * - `workspace-wide`: it reads across the workspace's channels, and nothing from
 *   a channel the caller cannot see may appear anywhere in what it returns.
 *   `query` is what the read needs to return anything at all — search needs `q`.
 * - `none`: it names no channel and returns nothing from one, and says why.
 */
type Visibility =
  | { readonly kind: 'channel' }
  | { readonly kind: 'workspace-wide'; readonly query?: string }
  | { readonly kind: 'none'; readonly reason: string };

export interface CrossTenantCase {
  /** What a stranger is told — and, identically, somebody naming an id that never existed. */
  readonly refusal: Extract<ErrorCode, 'WORKSPACE_NOT_FOUND' | 'CHANNEL_NOT_FOUND'>;
  /**
   * A body the owner's identical request succeeds with. Without it a `POST` would
   * be refused for its body, and the `404` would never have been reached.
   */
  readonly body?: (now: Date) => unknown;
  readonly visibility: Visibility;
}

const CHANNEL: Visibility = { kind: 'channel' };

export const CROSS_TENANT: Readonly<Record<string, CrossTenantCase>> = {
  'GET /api/workspaces/:workspaceId': {
    refusal: 'WORKSPACE_NOT_FOUND',
    visibility: { kind: 'none', reason: 'the workspace itself; no channel is named or listed' },
  },
  'GET /api/workspaces/:workspaceId/members': {
    refusal: 'WORKSPACE_NOT_FOUND',
    visibility: { kind: 'none', reason: 'workspace membership, which is not per channel' },
  },
  'GET /api/workspaces/:workspaceId/channels': {
    refusal: 'WORKSPACE_NOT_FOUND',
    visibility: { kind: 'workspace-wide' },
  },
  'POST /api/workspaces/:workspaceId/channels': {
    refusal: 'WORKSPACE_NOT_FOUND',
    body: () => ({ name: 'crossing' }),
    visibility: { kind: 'none', reason: 'creates a channel; it returns only the one created' },
  },
  'GET /api/channels/:channelId': { refusal: 'CHANNEL_NOT_FOUND', visibility: CHANNEL },
  'POST /api/channels/:channelId/join': { refusal: 'CHANNEL_NOT_FOUND', visibility: CHANNEL },
  'GET /api/channels/:channelId/messages': { refusal: 'CHANNEL_NOT_FOUND', visibility: CHANNEL },
  'POST /api/channels/:channelId/messages': {
    refusal: 'CHANNEL_NOT_FOUND',
    body: (now) => ({ id: messageId(now), content: 'crossing' }),
    visibility: CHANNEL,
  },
};

/**
 * The two reads D-34 was written about: they span channels, so they are where a
 * private conversation leaks. When either is served it must be `workspace-wide`.
 */
export const WORKSPACE_WIDE_READS: readonly string[] = [
  'GET /api/workspaces/:workspaceId/search',
  'GET /api/workspaces/:workspaceId/unresolved',
];

/** Endpoints with no tenant to cross, each with the reason. */
export const UNSCOPED: Readonly<Record<string, string>> = {
  'GET /api/me': 'answers about the caller; the memberships it lists are their own',
  'GET /api/workspaces': 'lists the caller’s own memberships and names no workspace',
  'POST /api/workspaces': 'creates a workspace; there is nothing yet to be outside of',
};
