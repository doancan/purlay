/**
 * A pull request is one task, of a reviewable size, touching what its task is
 * about (#126).
 *
 * Scope creep inside a task is how debt arrives unreviewed: asked to fix X, the
 * change also reworks Y, and the review that would have caught Y is now too
 * large to do properly. Three rules, each a failing check rather than a
 * convention:
 *
 * 1. **It names its task.** The body says `Closes #n` — or `Part of #n` for a
 *    task that takes several pull requests. Dependabot names none, and is the one
 *    author excused: its changes are the manifests, which every task may touch.
 * 2. **It fits the budget.** At most `PRODUCTION_LINE_BUDGET` changed lines of
 *    production code. Tests, documents and generated files are not counted —
 *    counting tests would charge a change for being well tested. Over budget
 *    passes only with the `large-change` label, visible to the reviewer (D-74).
 * 3. **It touches what its task is about.** The issues it names carry area
 *    labels, and each area allows some paths; a file outside all of them fails.
 *    There is no label for this one: split the change, or name the issue it
 *    also serves.
 *
 * Run in CI on every pull request; `bun run check:pr <number>` runs it locally.
 */

/** Measured on the 32 pull requests merged before this existed: the largest focused one was 357. */
export const PRODUCTION_LINE_BUDGET = 400;

export const OVERRIDE_LABEL = 'large-change';

/** Never counted against the budget, and allowed in every task. */
const UNMETERED = [
  /\.test\.tsx?$/,
  /^docs\//,
  /\.md$/,
  /(^|\/)bun\.lock$/,
  /^packages\/db\/src\/schema\.ts$/,
  /^packages\/tokens\/src\/generated\//,
  /^\.env\.example$/,
  /(^|\/)package\.json$/,
];

/**
 * What each area label allows. A label not listed here — `infra`, `testing`,
 * `security` — is cross-cutting by nature and restricts nothing.
 */
const AREA_PATHS: Readonly<Record<string, readonly string[]>> = {
  web: ['apps/web/', 'packages/types/'],
  api: ['apps/api/', 'packages/types/', 'packages/db/'],
  realtime: ['apps/api/', 'packages/types/'],
  database: ['packages/db/', 'apps/api/'],
  contracts: ['packages/types/', 'apps/api/', 'apps/web/'],
  docs: [],
};

const CROSS_CUTTING = new Set(['infra', 'testing', 'security']);

export interface ChangedFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface PullRequest {
  readonly body: string;
  readonly author: string;
  readonly labels: readonly string[];
  readonly files: readonly ChangedFile[];
}

/** `Closes #12`, `fixes #3`, `Resolves #4`, `Part of #202` — every issue the body names. */
export const linkedIssues = (body: string): number[] => [
  ...new Set(
    [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|part of)\s+#(\d+)/gi)].map(
      (match) => Number(match[1]),
    ),
  ),
];

const unmetered = (path: string): boolean => UNMETERED.some((pattern) => pattern.test(path));

export const productionLines = (files: readonly ChangedFile[]): number =>
  files
    .filter((file) => !unmetered(file.path))
    .reduce((sum, file) => sum + file.additions + file.deletions, 0);

const DEPENDABOT = new Set(['dependabot[bot]', 'app/dependabot']);

/** Every rule the pull request breaks, in words a person can act on; empty when it passes. */
export const judge = (
  pull: PullRequest,
  issueLabels: ReadonlyMap<number, readonly string[]>,
): string[] => {
  if (DEPENDABOT.has(pull.author)) return [];
  const problems: string[] = [];

  const issues = linkedIssues(pull.body);
  if (issues.length === 0) {
    problems.push(
      'It names no issue. Say "Closes #n", or "Part of #n" for a task that takes several pull requests.',
    );
  }

  const lines = productionLines(pull.files);
  if (lines > PRODUCTION_LINE_BUDGET && !pull.labels.includes(OVERRIDE_LABEL)) {
    problems.push(
      `It changes ${String(lines)} lines of production code; the budget is ${String(PRODUCTION_LINE_BUDGET)}. Split it, or label it "${OVERRIDE_LABEL}" so its size is a decision the reviewer can see.`,
    );
  }

  const labels = issues.flatMap((issue) => issueLabels.get(issue) ?? []);
  if (issues.length > 0 && !labels.some((label) => CROSS_CUTTING.has(label))) {
    const allowed = labels.flatMap((label) => AREA_PATHS[label] ?? []);
    const areas = labels.filter((label) => label in AREA_PATHS);
    if (areas.length > 0) {
      const outside = pull.files
        .map((file) => file.path)
        .filter((path) => !unmetered(path) && !allowed.some((prefix) => path.startsWith(prefix)));
      if (outside.length > 0) {
        problems.push(
          `It touches files outside what its issues are about (${areas.join(', ')}): ${outside.join(', ')}. Split it, or name the issue those files serve.`,
        );
      }
    }
  }
  return problems;
};
