/**
 * Which file of this directory a mutation belongs in (`CONTRIBUTING.md` §5).
 *
 * A mutation goes by the code it mutates (its `file`), not by the pull request that added it, so two
 * pull requests that guard different code touch different files. Each area is one file,
 * `scripts/mutations/<name>.ts`, holding its entries in ascending id order: a new entry goes where
 * its id sorts, never at the end, so two pull requests rarely edit the same lines.
 *
 * A file holds about 130 entries at most. When one grows past that, give the next path segment its own
 * area: a line here, a new file, one import in `index.ts`. A mutation of a file no area covers is
 * refused by `areaOf`, which says what to add. The longest matching prefix wins, so a directory can
 * be split from the area that holds the rest of it.
 */

export interface Area {
  readonly name: string;
  /** Directories end in a slash; a file is its whole path. */
  readonly prefixes: readonly string[];
}

export const AREAS = [
  { name: 'repo', prefixes: ['.github/', 'docker', 'Dockerfile', 'docs/'] },
  { name: 'scripts', prefixes: ['scripts/'] },
  { name: 'packages-db', prefixes: ['packages/db/'] },
  { name: 'packages-markdown', prefixes: ['packages/markdown/'] },
  { name: 'packages-tokens', prefixes: ['packages/tokens/'] },
  { name: 'packages-types', prefixes: ['packages/types/'] },
  {
    name: 'api-root',
    prefixes: [
      'apps/api/src/composition.ts',
      'apps/api/src/contract/',
      'apps/api/src/export-catalogue.ts',
      'apps/api/src/index.ts',
      'apps/api/src/lifecycle.ts',
      'apps/api/src/testing/',
    ],
  },
  { name: 'api-cli', prefixes: ['apps/api/src/cli/'] },
  { name: 'api-chat', prefixes: ['apps/api/src/features/chat/'] },
  { name: 'api-chat-channels', prefixes: ['apps/api/src/features/chat/channels/'] },
  { name: 'api-chat-integrations', prefixes: ['apps/api/src/features/chat/integrations/'] },
  { name: 'api-chat-messages', prefixes: ['apps/api/src/features/chat/messages/'] },
  { name: 'api-chat-notifications', prefixes: ['apps/api/src/features/chat/notifications/'] },
  { name: 'api-issues', prefixes: ['apps/api/src/features/issues/'] },
  { name: 'api-ingress-http', prefixes: ['apps/api/src/ingress/http/'] },
  {
    name: 'api-ingress-http-auth',
    prefixes: [
      'apps/api/src/ingress/http/auth-methods.ts',
      'apps/api/src/ingress/http/auth.ts',
      'apps/api/src/ingress/http/devices.ts',
      'apps/api/src/ingress/http/native-handoff.ts',
      'apps/api/src/ingress/http/session.ts',
    ],
  },
  {
    name: 'api-ingress-http-setup',
    prefixes: ['apps/api/src/ingress/http/rate-limit.ts', 'apps/api/src/ingress/http/setup.ts'],
  },
  { name: 'api-ingress-ws', prefixes: ['apps/api/src/ingress/ws/'] },
  { name: 'api-modules-attachments', prefixes: ['apps/api/src/modules/attachments/'] },
  { name: 'api-modules-audit', prefixes: ['apps/api/src/modules/audit/'] },
  { name: 'api-modules-auth', prefixes: ['apps/api/src/modules/auth/'] },
  {
    name: 'api-modules-auth-better-auth',
    prefixes: ['apps/api/src/modules/auth/better-auth.ts'],
  },
  { name: 'api-modules-export', prefixes: ['apps/api/src/modules/export/'] },
  { name: 'api-modules-find', prefixes: ['apps/api/src/modules/find/'] },
  { name: 'api-modules-images', prefixes: ['apps/api/src/modules/images/'] },
  { name: 'api-modules-inbox', prefixes: ['apps/api/src/modules/inbox/'] },
  { name: 'api-modules-jobs', prefixes: ['apps/api/src/modules/jobs/'] },
  { name: 'api-modules-push', prefixes: ['apps/api/src/modules/push/'] },
  { name: 'api-modules-setup', prefixes: ['apps/api/src/modules/setup/'] },
  { name: 'api-modules-setup-probes', prefixes: ['apps/api/src/modules/setup/probes.ts'] },
  {
    name: 'api-modules-setup-runtime',
    prefixes: [
      'apps/api/src/modules/setup/runtime.ts',
      'apps/api/src/modules/setup/verification.ts',
      'apps/api/src/modules/setup/wizard.ts',
    ],
  },
  { name: 'api-modules-setup-settings', prefixes: ['apps/api/src/modules/setup/settings.ts'] },
  { name: 'api-modules-setup-setup', prefixes: ['apps/api/src/modules/setup/setup.ts'] },
  { name: 'api-modules-users', prefixes: ['apps/api/src/modules/users/'] },
  { name: 'api-modules-workers', prefixes: ['apps/api/src/modules/workers/'] },
  { name: 'api-modules-workspaces', prefixes: ['apps/api/src/modules/workspaces/'] },
  { name: 'api-platform', prefixes: ['apps/api/src/platform/'] },
  { name: 'api-realtime', prefixes: ['apps/api/src/realtime/'] },
  {
    name: 'web-core',
    prefixes: [
      'apps/web/playwright.config.ts',
      'apps/web/public/',
      'apps/web/src/app/',
      'apps/web/src/data/',
      'apps/web/src/i18n/',
      'apps/web/src/modules/',
      'apps/web/src/router/',
      'apps/web/src/theme/',
      'apps/web/src/ui/',
    ],
  },
  { name: 'web-realtime', prefixes: ['apps/web/src/realtime/'] },
  { name: 'web-features', prefixes: ['apps/web/src/features/'] },
  { name: 'web-features-channel', prefixes: ['apps/web/src/features/chat/channel/'] },
  { name: 'web-features-composer', prefixes: ['apps/web/src/features/chat/composer/'] },
  { name: 'web-features-sidebar', prefixes: ['apps/web/src/features/chat/sidebar/'] },
] as const satisfies readonly Area[];

export type AreaName = (typeof AREAS)[number]['name'];

/** The area a mutation of `file` belongs in: the longest matching prefix wins. */
export const areaOf = (file: string): AreaName => {
  let best: { readonly name: AreaName; readonly length: number } | undefined;
  for (const area of AREAS) {
    for (const prefix of area.prefixes) {
      if (file.startsWith(prefix) && (best === undefined || prefix.length > best.length)) {
        best = { name: area.name, length: prefix.length };
      }
    }
  }
  if (best === undefined) {
    throw new Error(`no area in scripts/mutations/areas.ts covers ${file}: add its prefix to one`);
  }
  return best.name;
};
