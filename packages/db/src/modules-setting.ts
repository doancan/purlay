/**
 * The one reading of the `MODULES` setting (`MODULES.md` §3, D-250).
 *
 * Two commands read this setting — `bun run db:migrate`, which decides which sets of migrations to apply, and
 * the API, which decides which modules to start — and they once had a tokenizer each, so `CHAT` migrated the
 * core alone while the API refused it, and `chat,` migrated chat's set before the API refused. Both call this
 * function now. It is pure and knows no module but the ids it is given.
 *
 * What it judges is the setting's own shape: a closed grammar of ids, no empty item, no repeat, `none` alone,
 * and no id the build lacks. What a module needs from another (`requires`) is judged by `unmetRequirements`, over
 * a table of requirements each caller supplies: the API from its manifests, `db:migrate` from the build's
 * `PRODUCT_MODULE_REQUIRES`, which a test holds to the manifests.
 */

/** A module id: lowercase letters, digits and hyphens, starting with a letter. */
export const MODULE_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** The setting that runs the core alone: written out, because blank is read as unset. */
const NO_MODULES = 'none';

export type ModulesSetting =
  | { readonly kind: 'all' }
  | { readonly kind: 'none' }
  | { readonly kind: 'named'; readonly ids: readonly string[] };

/** A setting that cannot be run. `problems` is every reason, one sentence each. */
export class ModulesSettingError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `MODULES cannot start this process:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    );
    this.name = 'ModulesSettingError';
    this.problems = problems;
  }
}

/**
 * Unset or blank is every module the build carries (the configuration reads a blank variable as unset
 * everywhere), `none` alone is the core alone, otherwise the trimmed ids listed. Throws `ModulesSettingError`
 * naming every problem at once.
 */
export const parseModulesSetting = (
  setting: string | undefined,
  knownIds: readonly string[],
): ModulesSetting => {
  const trimmed = (setting ?? '').trim();
  if (trimmed === '') return { kind: 'all' };
  if (trimmed === NO_MODULES) return { kind: 'none' };

  const problems: string[] = [];
  const named = new Set<string>();
  const items = trimmed.split(',').map((item) => item.trim());

  const say = (problem: string): void => {
    if (!problems.includes(problem)) problems.push(problem);
  };
  for (const item of items) {
    if (item === '') {
      say('MODULES has an empty item: a doubled or trailing comma');
    } else if (item === NO_MODULES) {
      say(`MODULES has "${NO_MODULES}" with other items: ${NO_MODULES} must stand alone`);
    } else if (named.has(item)) {
      say(`MODULES names "${item}" twice`);
    } else if (!MODULE_ID.test(item)) {
      say(
        `MODULES names "${item}", which is not a module id: lowercase letters, digits and hyphens, starting with a letter`,
      );
    } else if (!knownIds.includes(item)) {
      say(
        `MODULES names "${item}", which this build does not have (it has: ${knownIds.length === 0 ? 'none' : knownIds.join(', ')})`,
      );
    }
    named.add(item);
  }
  if (problems.length > 0) throw new ModulesSettingError(problems);
  return { kind: 'named', ids: [...named] };
};

/**
 * One sentence for each module named whose requirement is not named too, in the order of `requires`, the table of
 * every module's requirements by id. The sentence is the same wherever the setting is read.
 */
export const unmetRequirements = (
  named: readonly string[],
  requires: Readonly<Record<string, readonly string[]>>,
): readonly string[] =>
  Object.entries(requires)
    .filter(([id]) => named.includes(id))
    .flatMap(([id, required]) =>
      required
        .filter((other) => !named.includes(other))
        .map((other) => `"${id}" requires "${other}", which MODULES does not enable`),
    );
