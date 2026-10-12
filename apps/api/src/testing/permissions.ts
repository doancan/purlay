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
  'read the audit trail': {
    endpoint: 'GET /api/workspaces/:workspaceId/audit',
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
  'delete somebody else’s message': {
    endpoint: 'DELETE /api/messages/:messageId',
    allowed: { owner: true, admin: true, member: false },
  },
};
