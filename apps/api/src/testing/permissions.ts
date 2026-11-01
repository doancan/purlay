/**
 * The permission matrix as a table (`ARCHITECTURE.md` §7.4, #74): every role-gated action, what
 * each role is told. `ingress/http/permissions.integration.test.ts` makes each request as each role;
 * `permissions.test.ts` holds that every role-gated endpoint `API.md` serves is in here, so a new one
 * cannot ship with only its happy path tried.
 *
 * `true` is the action succeeding; `false` is `403 FORBIDDEN` — refused for what the caller is, after
 * their membership has made the workspace exist for them.
 */
import type { UserRole } from '@purlay/types';

export interface PermissionCase {
  /** The documented endpoint, as `API.md` names it. */
  readonly endpoint: string;
  readonly allowed: Readonly<Record<UserRole, boolean>>;
}

export const PERMISSIONS: Readonly<Record<string, PermissionCase>> = {
  'make a member an admin': {
    endpoint: 'PATCH /api/workspaces/:workspaceId/members/:userId',
    allowed: { owner: true, admin: true, member: false },
  },
  'make a member an owner (transfer ownership)': {
    endpoint: 'PATCH /api/workspaces/:workspaceId/members/:userId',
    allowed: { owner: true, admin: false, member: false },
  },
  'remove a member': {
    endpoint: 'DELETE /api/workspaces/:workspaceId/members/:userId',
    allowed: { owner: true, admin: true, member: false },
  },
  'rename the workspace': {
    endpoint: 'PATCH /api/workspaces/:workspaceId',
    allowed: { owner: true, admin: true, member: false },
  },
  'read how long the history is kept': {
    endpoint: 'GET /api/workspaces/:workspaceId/retention',
    allowed: { owner: true, admin: false, member: false },
  },
  'set how long the history is kept': {
    endpoint: 'PUT /api/workspaces/:workspaceId/retention',
    allowed: { owner: true, admin: false, member: false },
  },
  'read how long a channel keeps its history': {
    endpoint: 'GET /api/channels/:channelId/retention',
    allowed: { owner: true, admin: false, member: false },
  },
  'let a channel keep its history longer': {
    endpoint: 'PUT /api/channels/:channelId/retention',
    allowed: { owner: true, admin: false, member: false },
  },
  'ask for the workspace to be deleted': {
    endpoint: 'POST /api/workspaces/:workspaceId/deletion',
    allowed: { owner: true, admin: false, member: false },
  },
  'take back the workspace’s deletion': {
    endpoint: 'DELETE /api/workspaces/:workspaceId/deletion',
    allowed: { owner: true, admin: false, member: false },
  },
  'export the workspace': {
    endpoint: 'POST /api/workspaces/:workspaceId/exports',
    allowed: { owner: true, admin: false, member: false },
  },
  'read the workspace’s exports': {
    endpoint: 'GET /api/workspaces/:workspaceId/exports',
    allowed: { owner: true, admin: false, member: false },
  },
  'download an export': {
    endpoint: 'GET /api/workspaces/:workspaceId/exports/:exportId/download',
    allowed: { owner: true, admin: false, member: false },
  },
  'read the audit trail': {
    endpoint: 'GET /api/workspaces/:workspaceId/audit',
    allowed: { owner: true, admin: true, member: false },
  },
  'download the audit trail': {
    endpoint: 'GET /api/workspaces/:workspaceId/audit/export',
    allowed: { owner: true, admin: true, member: false },
  },
  'see whether the GitHub token is set': {
    endpoint: 'GET /api/workspaces/:workspaceId/integrations/github',
    allowed: { owner: true, admin: true, member: false },
  },
  'set the GitHub token': {
    endpoint: 'PUT /api/workspaces/:workspaceId/integrations/github',
    allowed: { owner: true, admin: true, member: false },
  },
  'remove the GitHub token': {
    endpoint: 'DELETE /api/workspaces/:workspaceId/integrations/github',
    allowed: { owner: true, admin: true, member: false },
  },
  'list a channel’s repository feeds': {
    endpoint: 'GET /api/channels/:channelId/github-feeds',
    allowed: { owner: true, admin: true, member: false },
  },
  'connect a repository to a channel': {
    endpoint: 'POST /api/channels/:channelId/github-feeds',
    allowed: { owner: true, admin: true, member: false },
  },
  'disconnect a repository from a channel': {
    endpoint: 'DELETE /api/channels/:channelId/github-feeds/:feedId',
    allowed: { owner: true, admin: true, member: false },
  },
  'list a channel’s incoming webhooks': {
    endpoint: 'GET /api/channels/:channelId/incoming-webhooks',
    allowed: { owner: true, admin: true, member: false },
  },
  'make an incoming webhook': {
    endpoint: 'POST /api/channels/:channelId/incoming-webhooks',
    allowed: { owner: true, admin: true, member: false },
  },
  'revoke an incoming webhook': {
    endpoint: 'DELETE /api/channels/:channelId/incoming-webhooks/:webhookId',
    allowed: { owner: true, admin: true, member: false },
  },
  'make an invitation link': {
    endpoint: 'POST /api/workspaces/:workspaceId/invitations',
    allowed: { owner: true, admin: true, member: false },
  },
  'list the invitation links': {
    endpoint: 'GET /api/workspaces/:workspaceId/invitations',
    allowed: { owner: true, admin: true, member: false },
  },
  'revoke an invitation link': {
    endpoint: 'DELETE /api/workspaces/:workspaceId/invitations/:invitationId',
    allowed: { owner: true, admin: true, member: false },
  },
  'take somebody out of a public channel': {
    endpoint: 'DELETE /api/channels/:channelId/members/:userId',
    allowed: { owner: true, admin: true, member: false },
  },
  'read the workspace’s storage and quota': {
    endpoint: 'GET /api/workspaces/:workspaceId/storage',
    allowed: { owner: true, admin: false, member: false },
  },
  'let only owners and admins post in a channel': {
    endpoint: 'PATCH /api/channels/:channelId',
    allowed: { owner: true, admin: true, member: false },
  },
  'archive a channel': {
    endpoint: 'DELETE /api/channels/:channelId',
    allowed: { owner: true, admin: true, member: false },
  },
  'see the archived channels': {
    endpoint: 'GET /api/workspaces/:workspaceId/archived-channels',
    allowed: { owner: true, admin: true, member: false },
  },
  'bring an archived channel back': {
    endpoint: 'POST /api/channels/:channelId/restore',
    allowed: { owner: true, admin: true, member: false },
  },
  'delete somebody else’s message': {
    endpoint: 'DELETE /api/messages/:messageId',
    allowed: { owner: true, admin: true, member: false },
  },
};
