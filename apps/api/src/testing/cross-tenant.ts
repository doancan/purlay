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
  readonly messageId: string;
  /** An image the message carries. */
  readonly attachmentId: string;
  /** An upload not sent yet: what a discard acts on. */
  readonly unsentAttachmentId: string;
  /** A member of the workspace who is not its owner: what managing a member acts on. */
  readonly memberId: string;
  /** A link of the workspace that still opens: what revoking acts on. */
  readonly invitationId: string;
}

/** The one emoji a crossing reacts with, as a path segment: percent-encoded, as a client sends it. */
const CROSSING_EMOJI = encodeURIComponent('👍');

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
    if (name === 'messageId') return ids.messageId;
    if (name === 'attachmentId') return ids.attachmentId;
    if (name === 'userId') return ids.memberId;
    if (name === 'invitationId') return ids.invitationId;
    if (name === 'emoji') return CROSSING_EMOJI;
    throw new Error(`no id for \`:${name}\` in ${path} — teach \`pathFor\` and \`Ids\` about it`);
  });

/**
 * Where an endpoint sits on the channel-visibility axis.
 *
 * - `channel`: it names one channel, and a workspace member who cannot see that
 *   channel is told it does not exist.
 * - `message`: it names one message, and a workspace member who cannot see the
 *   channel the message is in is told it does not exist — the same refusal as for a
 *   message that was never written.
 * - `workspace-wide`: it reads across the workspace's channels, and nothing from
 *   a channel the caller cannot see may appear anywhere in what it returns.
 *   `query` is what the read needs to return anything at all — search needs `q`.
 * - `none`: it names no channel and returns nothing from one, and says why.
 */
type Visibility =
  /**
   * `admin`: only an owner or an admin may use the endpoint, so the caller crossing the axis is made
   * an admin of the workspace first — the refusal is then for what they cannot see, never for what
   * they are, and the control succeeds.
   */
  | { readonly kind: 'channel'; readonly admin?: true }
  /**
   * `author`: only the message's author may use the endpoint, so the control is a message the
   * caller wrote, and the hidden ones include messages they wrote in channels they cannot see.
   */
  | { readonly kind: 'message'; readonly author?: true }
  | { readonly kind: 'workspace-wide'; readonly query?: string }
  | { readonly kind: 'none'; readonly reason: string };

/**
 * What a body may need from the owner's side of a crossing and cannot derive: the
 * owner themself (a direct message with a person who is certainly in the
 * workspace), a message of the owner's channel (a read position names one) and the
 * workspace, for a body that names it (marking an inbox read). The
 * stranger's request carries the same body, which is how a refusal that came before
 * the body was read is told from one that came after.
 */
export interface OwnerIds {
  readonly userId: string;
  readonly messageId: string;
  readonly workspaceId: string;
}

export interface CrossTenantCase {
  /** What a stranger is told — and, identically, somebody naming an id that never existed. */
  readonly refusal: Extract<
    ErrorCode,
    'WORKSPACE_NOT_FOUND' | 'CHANNEL_NOT_FOUND' | 'MESSAGE_NOT_FOUND' | 'ATTACHMENT_NOT_FOUND'
  >;
  /** It acts on an upload not sent yet, so the crossing names that one (`unsentAttachmentId`). */
  readonly unsent?: true;
  /**
   * A body the owner's identical request succeeds with. Without it a `POST` would
   * be refused for its body, and the `404` would never have been reached.
   */
  readonly body?: (now: Date, owner: OwnerIds) => unknown;
  /** The query string the request needs to be one the endpoint can answer (an upload's id and name). */
  readonly query?: string;
  readonly visibility: Visibility;
}

const CHANNEL: Visibility = { kind: 'channel' };
const MESSAGE: Visibility = { kind: 'message' };
const MESSAGE_BY_AUTHOR: Visibility = { kind: 'message', author: true };

/**
 * The query string a case needs to be a request the endpoint can answer at all — search needs `q`,
 * the inbox its `workspaceId`. Without it the owner's own request would be a `400`, and every
 * crossing would be refused for the wrong reason. Its `:workspaceId` is filled in by `pathFor`, with
 * the rest of the path.
 */
export const queryFor = (crossing: CrossTenantCase): string => {
  const query =
    crossing.query ??
    (crossing.visibility.kind === 'workspace-wide' ? crossing.visibility.query : undefined);
  return query === undefined ? '' : `?${query}`;
};

export const CROSS_TENANT: Readonly<Record<string, CrossTenantCase>> = {
  'GET /api/workspaces/:workspaceId': {
    refusal: 'WORKSPACE_NOT_FOUND',
    visibility: { kind: 'none', reason: 'the workspace itself; no channel is named or listed' },
  },
  'PATCH /api/workspaces/:workspaceId': {
    refusal: 'WORKSPACE_NOT_FOUND',
    body: () => ({ name: 'crossing' }),
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
  'PATCH /api/channels/:channelId': {
    refusal: 'CHANNEL_NOT_FOUND',
    body: () => ({ topic: 'crossing' }),
    visibility: CHANNEL,
  },
  'DELETE /api/channels/:channelId': {
    refusal: 'CHANNEL_NOT_FOUND',
    visibility: { kind: 'channel', admin: true },
  },
  'POST /api/channels/:channelId/leave': { refusal: 'CHANNEL_NOT_FOUND', visibility: CHANNEL },
  'GET /api/channels/:channelId/members': { refusal: 'CHANNEL_NOT_FOUND', visibility: CHANNEL },
  'POST /api/channels/:channelId/join': { refusal: 'CHANNEL_NOT_FOUND', visibility: CHANNEL },
  'POST /api/channels/:channelId/members': {
    refusal: 'CHANNEL_NOT_FOUND',
    body: (_now, owner) => ({ userId: owner.userId }),
    visibility: CHANNEL,
  },
  'GET /api/channels/:channelId/messages': { refusal: 'CHANNEL_NOT_FOUND', visibility: CHANNEL },
  'POST /api/workspaces/:workspaceId/dms': {
    refusal: 'WORKSPACE_NOT_FOUND',
    body: (_now, owner) => ({ userId: owner.userId }),
    visibility: {
      kind: 'none',
      reason: 'opens a direct message; it returns only the one it opened',
    },
  },
  'PUT /api/channels/:channelId/read': {
    refusal: 'CHANNEL_NOT_FOUND',
    body: (_now, owner) => ({ lastReadMessageId: owner.messageId }),
    visibility: CHANNEL,
  },
  'POST /api/channels/:channelId/messages': {
    refusal: 'CHANNEL_NOT_FOUND',
    body: (now) => ({ id: messageId(now), content: 'crossing' }),
    visibility: CHANNEL,
  },
  'PUT /api/messages/:messageId/reactions/:emoji': {
    refusal: 'MESSAGE_NOT_FOUND',
    visibility: MESSAGE,
  },
  'DELETE /api/messages/:messageId/reactions/:emoji': {
    refusal: 'MESSAGE_NOT_FOUND',
    visibility: MESSAGE,
  },
  'DELETE /api/messages/:messageId': {
    refusal: 'MESSAGE_NOT_FOUND',
    visibility: MESSAGE_BY_AUTHOR,
  },
  'PATCH /api/messages/:messageId': {
    refusal: 'MESSAGE_NOT_FOUND',
    body: () => ({ content: 'crossing' }),
    visibility: MESSAGE_BY_AUTHOR,
  },
  'GET /api/messages/:messageId/thread': { refusal: 'MESSAGE_NOT_FOUND', visibility: MESSAGE },
  'POST /api/messages/:messageId/resolve': { refusal: 'MESSAGE_NOT_FOUND', visibility: MESSAGE },
  'DELETE /api/messages/:messageId/resolve': { refusal: 'MESSAGE_NOT_FOUND', visibility: MESSAGE },
  'GET /api/workspaces/:workspaceId/unresolved': {
    refusal: 'WORKSPACE_NOT_FOUND',
    visibility: { kind: 'workspace-wide' },
  },
  'GET /api/workspaces/:workspaceId/search': {
    refusal: 'WORKSPACE_NOT_FOUND',
    visibility: { kind: 'workspace-wide', query: 'q=question' },
  },
  'PUT /api/channels/:channelId/notification-level': {
    refusal: 'CHANNEL_NOT_FOUND',
    body: () => ({ level: 'none' }),
    visibility: CHANNEL,
  },
  'PUT /api/workspaces/:workspaceId/deep-work': {
    refusal: 'WORKSPACE_NOT_FOUND',
    body: () => ({ active: false }),
    visibility: {
      kind: 'none',
      reason: 'the caller’s own membership of the workspace; no channel is named',
    },
  },
  'POST /api/workspaces/:workspaceId/uploads': {
    refusal: 'WORKSPACE_NOT_FOUND',
    query: 'id=0199155c-6200-7b7f-8c11-2a4d3f9e1b70&name=crossing.bin',
    body: () => new Uint8Array([1, 2, 3]),
    visibility: {
      kind: 'none',
      reason: 'an upload names no channel; it is the uploader’s alone until a message carries it',
    },
  },
  'POST /api/integrations/github/unfurl': {
    refusal: 'WORKSPACE_NOT_FOUND',
    body: (_now, owner) => ({
      workspaceId: owner.workspaceId,
      url: 'https://github.com/acme/api/pull/1',
    }),
    visibility: {
      kind: 'none',
      reason:
        'names a workspace and a public address, no channel; the card is the workspace’s (D-112)',
    },
  },
  'GET /api/workspaces/:workspaceId/integrations/github': {
    refusal: 'WORKSPACE_NOT_FOUND',
    visibility: { kind: 'none', reason: 'the workspace’s own credential, no channel' },
  },
  'PUT /api/workspaces/:workspaceId/integrations/github': {
    refusal: 'WORKSPACE_NOT_FOUND',
    body: () => ({ token: 'ghp_crossing' }),
    visibility: { kind: 'none', reason: 'the workspace’s own credential, no channel' },
  },
  'DELETE /api/workspaces/:workspaceId/integrations/github': {
    refusal: 'WORKSPACE_NOT_FOUND',
    visibility: { kind: 'none', reason: 'the workspace’s own credential, no channel' },
  },
  'GET /api/workspaces/:workspaceId/audit': {
    refusal: 'WORKSPACE_NOT_FOUND',
    visibility: {
      kind: 'none',
      reason:
        'returns who did what and never anything written; a channel appears only as the id an admin created it under',
    },
  },
  'PATCH /api/workspaces/:workspaceId/members/:userId': {
    refusal: 'WORKSPACE_NOT_FOUND',
    body: () => ({ role: 'admin' }),
    visibility: {
      kind: 'none',
      reason:
        'names a person in the workspace and no channel; a role changes what they manage, not what they see',
    },
  },
  'DELETE /api/workspaces/:workspaceId/members/:userId': {
    refusal: 'WORKSPACE_NOT_FOUND',
    visibility: {
      kind: 'none',
      reason:
        'names a person and no channel; what they lose is every channel, told to their sockets (`revocation.integration.test.ts`)',
    },
  },
  'GET /api/attachments/:attachmentId': {
    refusal: 'ATTACHMENT_NOT_FOUND',
    visibility: {
      kind: 'none',
      reason:
        'its channel is its message’s, judged by `requireAttachmentById` on `visibleChannels`; a member outside a private channel, an unsent upload and a deleted message are asserted in `attachments.integration.test.ts`',
    },
  },
  'GET /api/attachments/:attachmentId/thumbnail': {
    refusal: 'ATTACHMENT_NOT_FOUND',
    visibility: {
      kind: 'none',
      reason:
        'the same guard as the original’s, asserted with it in `attachments.integration.test.ts`',
    },
  },
  'DELETE /api/attachments/:attachmentId': {
    refusal: 'ATTACHMENT_NOT_FOUND',
    unsent: true,
    visibility: {
      kind: 'none',
      reason: 'only an upload nobody has sent can be discarded, and it is in no channel yet',
    },
  },
  'POST /api/workspaces/:workspaceId/invitations': {
    refusal: 'WORKSPACE_NOT_FOUND',
    visibility: { kind: 'none', reason: 'a link into the workspace, which joins no channel' },
  },
  'GET /api/workspaces/:workspaceId/invitations': {
    refusal: 'WORKSPACE_NOT_FOUND',
    visibility: { kind: 'none', reason: 'the workspace’s links and who made them; no channel' },
  },
  'DELETE /api/workspaces/:workspaceId/invitations/:invitationId': {
    refusal: 'WORKSPACE_NOT_FOUND',
    visibility: {
      kind: 'none',
      reason:
        'names a link and no channel; another workspace’s link under your own is `invitations.integration.test.ts`',
    },
  },
  'GET /api/notifications': {
    refusal: 'WORKSPACE_NOT_FOUND',
    visibility: { kind: 'workspace-wide', query: 'workspaceId=:workspaceId' },
  },
  'PUT /api/notifications/read': {
    refusal: 'WORKSPACE_NOT_FOUND',
    body: (_now, owner) => ({ workspaceId: owner.workspaceId }),
    visibility: {
      kind: 'none',
      reason:
        'marks the caller’s own notifications; it answers nothing, and tells only their devices',
    },
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
  'GET /api/images':
    'names no workspace: an image on another server, fetched for anybody signed in; nothing of a tenant is read',
  'POST /api/invitations/preview':
    'names no workspace: the token is the capability, and opens only its own (`invitations.integration.test.ts`)',
  'POST /api/invitations/accept':
    'names no workspace: the token is the capability, and admits only to its own, into no channel',
};

/**
 * The method, headers and body of a crossing's request. A body that is bytes is an upload's
 * (`application/octet-stream`, with its length, D-109 §3); anything else is JSON.
 */
export const requestInit = (method: string, cookie: string, body: unknown): RequestInit => {
  if (body instanceof Uint8Array) {
    return {
      method,
      headers: {
        cookie,
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
      },
      body,
    };
  }
  return {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
};
