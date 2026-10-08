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
 */
import { readFileSync } from 'node:fs';
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

/** Every `/api/` endpoint `API.md` documents, in every phase. */
export const documentedEndpoints = (): readonly DocumentedEndpoint[] =>
  readFileSync('docs/API.md', 'utf8')
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

export interface CrossTenantCase {
  /** What a stranger is told — and, identically, somebody naming an id that never existed. */
  readonly refusal: Extract<ErrorCode, 'WORKSPACE_NOT_FOUND' | 'CHANNEL_NOT_FOUND'>;
  /**
   * A body the owner's identical request succeeds with. Without it a `POST` would
   * be refused for its body, and the `404` would never have been reached.
   */
  readonly body?: (now: Date) => unknown;
}

export const CROSS_TENANT: Readonly<Record<string, CrossTenantCase>> = {
  'GET /api/workspaces/:workspaceId': { refusal: 'WORKSPACE_NOT_FOUND' },
  'GET /api/workspaces/:workspaceId/members': { refusal: 'WORKSPACE_NOT_FOUND' },
  'GET /api/workspaces/:workspaceId/channels': { refusal: 'WORKSPACE_NOT_FOUND' },
  'POST /api/workspaces/:workspaceId/channels': {
    refusal: 'WORKSPACE_NOT_FOUND',
    body: () => ({ name: 'crossing' }),
  },
  'GET /api/channels/:channelId': { refusal: 'CHANNEL_NOT_FOUND' },
  'POST /api/channels/:channelId/join': { refusal: 'CHANNEL_NOT_FOUND' },
  'GET /api/channels/:channelId/messages': { refusal: 'CHANNEL_NOT_FOUND' },
  'POST /api/channels/:channelId/messages': {
    refusal: 'CHANNEL_NOT_FOUND',
    body: (now) => ({ id: messageId(now), content: 'crossing' }),
  },
};

/** Endpoints with no tenant to cross, each with the reason. */
export const UNSCOPED: Readonly<Record<string, string>> = {
  'GET /api/me': 'answers about the caller; the memberships it lists are their own',
  'GET /api/workspaces': 'lists the caller’s own memberships and names no workspace',
  'POST /api/workspaces': 'creates a workspace; there is nothing yet to be outside of',
};
