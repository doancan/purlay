// What a module's code may import of the core (D-250 rule 10, `MODULES.md` §4): everything under `platform/`, `modules/`,
// `ingress/` and `realtime/` is refused unless it is listed here, so a new core file is closed to every module until a line
// opens it. Kept out of `eslint.config.mjs` so a test can run it, as `feature-fences.mjs` is.

/** Every file of the core a module's code might import by a path. */
const CORE = ['**/platform/**', '**/modules/**', '**/ingress/**', '**/realtime/**'];

/**
 * Open to every module, as `[path from apps/api/src, the names that may be imported or all of them]`. What is here is
 * what a module of the product needs to be one: its tenancy, errors and clock, its ports, and the declarations the core
 * reads from it. `modules/auth/sessions` is opened for two names only: its other exports issue and end sessions.
 */
const BASE = [
  ['platform/clock'],
  ['platform/errors'],
  ['platform/events'],
  ['platform/fact-consumers'],
  ['platform/like-pattern'],
  ['platform/logging'],
  ['platform/module-budget'],
  ['platform/module-kit/manifest'],
  ['platform/module-kit/permissions'],
  ['platform/one-line'],
  ['platform/pagination'],
  ['platform/ports/*'],
  ['platform/tenancy'],
  ['platform/transactions'],
  ['modules/audit/audit'],
  ['modules/auth/sessions', ['requireLiveSession', 'SessionAuth']],
  ['modules/export/catalogue'],
  ['modules/export/personal-catalogue'],
  ['modules/push/notices'],
  ['modules/workers/module-workers'],
  ['modules/workspaces/deletion-purge'],
];

/** Open to the HTTP folder of every module (`features/<id>/http/`, D-280): the door's helpers, and not the door. */
const HTTP = [['ingress/http/module-routes'], ['ingress/http/session'], ['ingress/http/validate']];

/**
 * What a module has beyond the rest, with why it is not yet a port: chat grew before the rule. **It only shrinks**:
 * `module-seams.test.ts` fails for a line no file of the module imports, and for a module that grows its list past `CAP`.
 */
export const EXTRA = {
  chat: [
    ['ingress/http/client-address'],
    ['ingress/http/rate-limit'],
    ['modules/attachments/deletions'],
    ['modules/attachments/images'],
    ['modules/attachments/readable'],
    ['modules/attachments/uploads'],
    ['modules/images/fetch-external'],
    ['modules/images/proxy'],
    ['modules/jobs/jobs'],
    ['modules/push/sender'],
    ['modules/setup/settings'],
    ['modules/users/erasure'],
    ['modules/users/profile'],
    ['modules/workspaces/channels-port'],
    ['modules/workspaces/deep-work'],
    ['modules/workspaces/invitation-mail'],
    ['modules/workspaces/workspaces'],
    ['platform/client-key'],
    ['platform/crypto', ['CredentialCipher', 'SealBroken']],
    ['platform/frame-handlers'],
    ['platform/github-app-api'],
    ['platform/github-app-key', ['appJwt']],
    ['platform/hooks'],
    ['platform/letter'],
    ['platform/mail'],
    ['platform/readiness'],
    ['platform/storage', ['ObjectStore']],
    ['platform/tokens'],
  ],
};

/** The most lines `EXTRA` may hold in all: a module joins it only with this raised in the same change. */
export const EXTRA_CAP = 28;

const MESSAGE =
  'A module imports only what `scripts/module-reach.mjs` opens to it: the rest of the core is reached through a port, an event or the manifest, and a new core file is closed to every module. (D-250 rule 10, MODULES.md §4)';

/** The `no-restricted-imports` patterns of one feature's production code: the whole core refused, bar what is opened. */
export const reachPatterns = (id, http) => {
  const open = [...BASE, ...(http ? HTTP : []), ...(EXTRA[id] ?? [])];
  // A path cannot be opened under a folder that is refused, so each folder on the way to it is opened too (a folder's other
  // files stay refused by the pattern that refuses the core).
  const opened = open.flatMap(([path]) => {
    const parts = path.split('/');
    return parts.map((_, at) => `!**/${parts.slice(0, at + 1).join('/')}`);
  });
  return [
    { group: [...CORE, ...new Set(opened)], message: MESSAGE },
    ...open
      .filter(([, names]) => names !== undefined)
      .map(([path, names]) => ({
        group: [`**/${path}`],
        allowImportNames: names,
        message: MESSAGE,
      })),
  ];
};
