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
 */
export const featureFences = (dir, ids, noTransportTypes, paths) =>
  ids.map((id) => {
    const others = ids.filter((other) => other !== id);
    return {
      files: [`${dir}/${id}/**/*.ts`],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              noTransportTypes,
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
    };
  });
