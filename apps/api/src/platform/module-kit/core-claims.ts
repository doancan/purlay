/**
 * What the core itself claims, so that a module's manifest can be checked against it (`registry.ts`, D-250): a route, a
 * scheduled job, a socket operation or a server event a module lists must not be one the core already answers for.
 * Each list is held to the code by a test (`route-ownership.test.ts`, `core-claims.test.ts`), so a new core claim that is
 * not added here fails there rather than waiting for a module to collide with it.
 */
/**
 * The paths of the core, as `app.ts` registers them, each once, whatever the methods: `/ws` is the socket's upgrade, and a
 * trailing `*` is a catch-all (`templatesOverlap` reads it as the rest of the path).
 */
export const CORE_ROUTES: readonly string[] = [
  '/api/attachments/:attachmentId',
  '/api/attachments/:attachmentId/thumbnail',
  '/api/auth/methods',
  '/api/client',
  '/api/images',
  '/api/invitations/accept',
  '/api/invitations/passport',
  '/api/invitations/preview',
  '/api/me',
  '/api/me/away',
  '/api/me/erase',
  '/api/me/exports',
  '/api/me/exports/:exportId/download',
  '/api/me/locale',
  '/api/me/missed-mail',
  '/api/me/profile',
  '/api/me/quiet-hours',
  '/api/me/sessions',
  '/api/me/sessions/:sessionId',
  '/api/me/sign-in',
  '/api/native/authorize',
  '/api/native/token',
  '/api/push/key',
  '/api/push/subscriptions',
  '/api/push/subscriptions/remove',
  '/api/releases/latest',
  '/api/server/accounts',
  '/api/server/accounts/:userId/suspension',
  '/api/server/creators',
  '/api/server/github',
  '/api/server/github-app',
  '/api/server/google',
  '/api/server/oidc',
  '/api/server/policy',
  '/api/server/settings',
  '/api/server/smtp',
  '/api/workspaces',
  '/api/workspaces/:workspaceId',
  '/api/workspaces/:workspaceId/audit',
  '/api/workspaces/:workspaceId/audit/export',
  '/api/workspaces/:workspaceId/deep-work',
  '/api/workspaces/:workspaceId/deletion',
  '/api/workspaces/:workspaceId/exports',
  '/api/workspaces/:workspaceId/exports/:exportId/download',
  '/api/workspaces/:workspaceId/invitations',
  '/api/workspaces/:workspaceId/invitations/:invitationId',
  '/api/workspaces/:workspaceId/members',
  '/api/workspaces/:workspaceId/members/:userId',
  '/api/workspaces/:workspaceId/membership',
  '/api/workspaces/:workspaceId/retention',
  '/api/workspaces/:workspaceId/storage',
  '/api/workspaces/:workspaceId/uploads',
  '/auth/*',
  '/auth/email',
  '/auth/email/consume',
  '/auth/email/preview',
  '/auth/github',
  '/auth/google',
  '/auth/logout',
  '/auth/logout-all',
  '/auth/oidc',
  '/health',
  '/health/ready',
  '/metrics',
  '/setup/address',
  '/setup/admin',
  '/setup/claim',
  '/setup/finish',
  '/setup/github',
  '/setup/invite',
  '/setup/policy',
  '/setup/smtp',
  '/setup/state',
  '/setup/status',
  '/setup/verify',
  '/setup/workspace',
  '/ws',
];

/** The scheduled jobs (`bun run job <name>`) that keep the core's rows tidy and run whichever modules do. */
export const CORE_JOBS: readonly string[] = [
  'sweep:orphans',
  'sweep:sessions',
  'reconcile:storage',
  'sweep:link-previews',
  'sweep:github-deliveries',
  'sweep:email-sign-ins',
  'sweep:exports',
  'purge:retention',
  'purge:workspaces',
  'sweep:deletions',
];

/** The operations of a client frame the core answers. */
export const CORE_FRAMES: readonly string[] = ['PING', 'ACTIVE'];

/** The server events that reach every process, whichever modules it runs. */
export const CORE_EVENTS: readonly string[] = [
  'ACK',
  'ERROR',
  'SESSION_ENDED',
  'ACCESS_REVOKED',
  'DEEP_WORK_UPDATED',
  'WORKSPACE_UPDATED',
  'PONG',
];

/** What the core claims of each kind a manifest lists. */
export type CoreClaims = Readonly<
  Record<'routes' | 'jobs' | 'frames' | 'events', readonly string[]>
>;

export const CORE_CLAIMS: CoreClaims = {
  routes: CORE_ROUTES,
  jobs: CORE_JOBS,
  frames: CORE_FRAMES,
  events: CORE_EVENTS,
};
