/**
 * Every route the application registers belongs to the core or to a module, and says which (D-250, `MODULES.md` §3).
 *
 * A module that is not run has no route: its paths are the `404` of any unknown one. That holds only for the paths its
 * manifest lists, so a route added to `app.ts` that nobody classified would stay mounted with the module off. This reads the
 * paths `app.ts` registers and holds each to exactly one owner: the core's list below or a manifest's templates. A new
 * route fails here until it is put in one.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundledModules } from '../../composition';
import { ownsPath } from '../../platform/module-kit/routes';

/** The paths of the core, as `app.ts` registers them, each once, whatever the methods. */
const CORE_ROUTES: readonly string[] = [
  '/api/attachments/:attachmentId',
  '/api/attachments/:attachmentId/thumbnail',
  '/api/auth/methods',
  '/api/client',
  '/api/images',
  '/api/invitations/accept',
  '/api/invitations/passport',
  '/api/invitations/preview',
  '/api/me',
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
];

const registered = (): string[] => {
  const text = readFileSync(join(import.meta.dir, 'app.ts'), 'utf8');
  return [
    ...new Set(
      [...text.matchAll(/\.(?:get|post|put|patch|delete)\(\s*'(\/[^']*)'/g)].map((m) => m[1] ?? ''),
    ),
  ].sort();
};

describe('who owns each route', () => {
  const owners = bundledModules.map((module) => ({
    id: module.manifest.id,
    owns: ownsPath(module.manifest.routes ?? []),
  }));

  test('every route the application registers is the core’s or exactly one module’s', () => {
    const unowned: string[] = [];
    const twice: string[] = [];
    for (const path of registered()) {
      const by = [
        ...(CORE_ROUTES.includes(path) ? ['core'] : []),
        ...owners.filter((owner) => owner.owns(path)).map((owner) => owner.id),
      ];
      if (by.length === 0) unowned.push(path);
      if (by.length > 1) twice.push(`${path}: ${by.join(', ')}`);
    }
    expect({ unowned, twice }).toEqual({ unowned: [], twice: [] });
  });

  test('the core’s list holds no route that is gone, and no module’s template matches nothing', () => {
    const paths = registered();
    expect(CORE_ROUTES.filter((path) => !paths.includes(path))).toEqual([]);
    for (const module of bundledModules) {
      const dead = (module.manifest.routes ?? []).filter((template) => {
        const owns = ownsPath([template]);
        return !paths.some((path) => owns(path));
      });
      expect({ module: module.manifest.id, dead }).toEqual({
        module: module.manifest.id,
        dead: [],
      });
    }
  });
});
