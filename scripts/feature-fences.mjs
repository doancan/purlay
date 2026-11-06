// The lint fences of the product modules (D-250, `MODULES.md` §4), kept out of `eslint.config.mjs` so a
// test can run them: a config that only runs when a feature folder exists has nothing to run on today.
import { existsSync, readdirSync } from 'node:fs';

/** The ids of the folders under `dir`: found rather than listed, so a new module cannot forget its fence. */
export const featureIds = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];

/**
 * One block per feature: below the doors like a module, taking its executor as an argument, and importing
 * no other feature. One block each, because ESLint replaces a rule rather than merging it and the rule has
 * to name the others.
 *
 * `testPathsFor` gives a feature's tests their own paths, where they are held to less than the rest of it (they may hand
 * a service the whole database's executor): a block after the feature's own, for its `*.test.ts` files, when it is given.
 *
 * `httpTransportTypes` is what `features/<id>/http/` is kept from instead of `noTransportTypes`, when it is given: a module's
 * HTTP surface is part of the module (D-280) and so speaks the framework and the door's helpers, and is kept from the
 * other door and the others' features all the same. Its blocks come after the feature's, tests included, so they win; its
 * tests stand up the whole application (`createApp`, the composition, a database of their own) and are kept from no transport
 * and from no path of the database, as the doors' tests are.
 */
export const featureFences = (
  dir,
  ids,
  noTransportTypes,
  pathsFor,
  testPathsFor,
  httpTransportTypes,
) =>
  ids.flatMap((id) => {
    const others = ids.filter((other) => other !== id);
    const fence = (files, paths, transport = noTransportTypes) => ({
      files,
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              ...(transport === null ? [] : [transport]),
              ...(others.length === 0
                ? []
                : [
                    {
                      regex: String.raw`^(\.\./)+(${others.join('|')})(/|$)|(^|/)features/(${others.join('|')})(/|$)`,
                      message: `The feature "${id}" imports no other feature (${others.join(', ')}): they meet through events, ports and capabilities. (D-250, MODULES.md §4)`,
                    },
                  ]),
            ],
            paths,
          },
        ],
      },
    });
    return [
      fence([`${dir}/${id}/**/*.ts`], pathsFor(id)),
      ...(testPathsFor === undefined
        ? []
        : [fence([`${dir}/${id}/**/*.test.ts`], testPathsFor(id))]),
      ...(httpTransportTypes === undefined
        ? []
        : [
            fence([`${dir}/${id}/http/**/*.ts`], pathsFor(id), httpTransportTypes),
            ...(testPathsFor === undefined
              ? []
              : [fence([`${dir}/${id}/http/**/*.test.ts`], [], null)]),
          ]),
    ];
  });
