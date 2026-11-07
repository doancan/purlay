// The lint fences of the web client's modules (D-277, `MODULES.md` §6), kept out of `eslint.config.mjs` so a test can
// run them, as `feature-fences.mjs` does for the API. A module's web code is the folder `apps/web/src/features/<id>`
// that holds a `manifest.ts`; everything else under `apps/web/src` is the core, which includes the shared `ui/`, `lib/`,
// `data/` and the shell. Two rules, both about a direction:
//
//   * a module imports no other module;
//   * the core imports no module, except `modules/registry.ts`, which imports the manifests, and the files listed in
//     `CORE_IMPORTS_OF_MODULES`, which only shrinks.
//
// ESLint sees one file and the specifier as it was written, so it holds the rule per importing file; the test that
// reads the compiler's resolution (`web-fences.test.ts`) holds it per import and keeps the list honest.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The ids of a client's modules: the folders under `features/` that hold a manifest, found rather than listed. */
export const webModuleIds = (features) =>
  existsSync(features)
    ? readdirSync(features, { withFileTypes: true })
        .filter(
          (entry) => entry.isDirectory() && existsSync(join(features, entry.name, 'manifest.ts')),
        )
        .map((entry) => entry.name)
        .sort()
    : [];

/**
 * The imports of a module's files that the core still makes, each with why it is there and what ends it. The list only
 * shrinks: `web-fences.test.ts` fails for an import the core makes that is not here, for an entry that is no longer an
 * import, and for a list longer than its cap. Paths are relative to `apps/web/src`.
 */
export const CORE_IMPORTS_OF_MODULES = [
  ...[
    'channel/add-people.tsx',
    'conversations/group-details.tsx',
    'conversations/new-conversation.tsx',
    'messages/image-viewer.tsx',
    'sidebar/deferred.ts',
  ].map((file) => ({
    from: 'app/deferred.ts',
    to: `features/chat/${file}`,
    reason:
      'an overlay the shell opens on a key or a click, re-exported from the one lazy chunk the doors ask for (`deferred.ts`): it is in a chunk of its own, never in the shell. Ends with a manifest slot that lists a module\u2019s overlays.',
  })),
  ...['features/palette/match.ts', 'features/settings/pages/members.tsx'].map((from) => ({
    from,
    to: 'features/chat/composer/mention-suggest.ts',
    reason:
      'asks for `fold`, which compares names without case and marks and is chat\u2019s by ownership: moving it to `lib/` left the lazy side importing only that and moved 1.9 KB of mention list into chat\u2019s chunk, over its bound (D-277)',
  })),
  {
    from: 'features/palette/command-palette.tsx',
    to: 'features/chat/search/use-operators.ts',
    reason: 'the palette reads the search operators typed into it, the way the search screen does',
  },
  ...['inbox/inbox-link', 'sidebar/open-questions-link'].map((file) => ({
    from: 'features/shell/rail.tsx',
    to: `features/chat/${file}.tsx`,
    reason:
      'a rail entry that is more than a link (the inbox\u2019s dot and panel, the open-questions count) draws itself, by route, in the shell\u2019s first frame (`MODULES.md` \u00a76)',
  })),
  ...['composer/uploads', 'saved/save-toggle'].map((file) => ({
    from: 'features/shell/shell.tsx',
    to: `features/chat/${file}.tsx`,
    reason:
      'a provider the shell mounts round every screen: an upload in flight or a save intent must outlive the channel screen that began it',
  })),
  ...[
    'sidebar/channel-list',
    'sidebar/conversation-list',
    'sidebar/jump-field',
    'sidebar/people-list',
    'sidebar/preferences-context',
    'sidebar/sidebar-options',
    'sidebar/workspace-menu',
    'unreads/unreads-row',
  ].map((file) => ({
    from: 'features/shell/sidebar.tsx',
    to: `features/chat/${file}.tsx`,
    reason:
      'the sidebar\u2019s chat lists are drawn in the first frame, inside `WhenRun module="chat"`; a lazy chunk for them was built and measured and saved 2% of the shell for a layout fallback (`MODULES.md` \u00a711, 2026-11-03)',
  })),
];

/**
 * One block for each module and one for the core. `webPatterns` are the restrictions every file of the web already has:
 * ESLint replaces a rule rather than merging it, so a block that adds one restates them.
 */
export const webFences = (src, ids, webPatterns, allowedImporters) => {
  const intoAModule = (names, why) => ({
    regex: String.raw`^(\.\./)+(${names.join('|')})(/|$)|(^|/)features/(${names.join('|')})(/|$)`,
    message: why,
  });
  const files = (base) => [`${base}/**/*.ts`, `${base}/**/*.tsx`];
  const modules = ids.map((id) => {
    const others = ids.filter((other) => other !== id);
    return {
      files: files(`${src}/features/${id}`),
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              ...webPatterns,
              ...(others.length === 0
                ? []
                : [
                    intoAModule(
                      others,
                      `The module "${id}" imports no other module (${others.join(', ')}): they meet through the server's events and the contract, not through each other's screens. (D-277, MODULES.md §6)`,
                    ),
                  ]),
            ],
          },
        ],
      },
    };
  });
  return [
    ...modules,
    {
      files: files(src),
      ignores: [
        ...ids.flatMap((id) => files(`${src}/features/${id}`)),
        `${src}/modules/registry.ts`,
        // A test composes the whole client, and `testing/` is what tests are built with: neither is shipped.
        '**/*.test.ts',
        '**/*.test.tsx',
        `${src}/testing/**`,
        ...[...new Set(allowedImporters)].map((from) => `${src}/${from}`),
      ],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              ...webPatterns,
              intoAModule(
                ids,
                'The core imports no module: the shell reaches one through `modules/registry` and its manifest, and what is in `ui/`, `lib/` or `data/` is shared and has no module in it. A file that must stay is listed with its reason in `CORE_IMPORTS_OF_MODULES`, and the list only shrinks. (D-277, MODULES.md §6)',
              ),
            ],
          },
        ],
      },
    },
    {
      files: [`${src}/modules/registry.ts`],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              ...webPatterns,
              {
                regex: String.raw`(^|/)features/(${ids.join('|')})(?=/|$)(?!/manifest$)`,
                message:
                  'The registry imports each module’s manifest and nothing else: a manifest is data and one loader, so the shell carries no screen. (D-250, D-277)',
              },
            ],
          },
        ],
      },
    },
  ];
};
