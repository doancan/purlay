/**
 * A pull request is one task, touching what its task is about (#126).
 *
 * Scope creep inside a task is how debt arrives unreviewed: asked to fix X, the
 * change also reworks Y, and the review that would have caught Y is now too
 * large to do properly. Three rules, each a failing check rather than a
 * convention. Size is not one of them: a feature is as large as it is, and the line budget
 * that was here (D-74) was taken away at the owner's request:
 *
 * 1. **It names its task.** The body says `Closes #n` — or `Part of #n` for a
 *    task that takes several pull requests. No author is excused (D-219).
 * 2. **It touches what its task is about.** The issues it names carry area
 *    labels, and each area allows some paths; a file outside all of them fails.
 *    There is no label for this one: split the change, or name the issue it
 *    also serves.
 * 3. **It says how it fails.** A change to the product — `apps/` or
 *    `packages/` — answers each category of `CONTRIBUTING.md` §6.9 under
 *    `## Failure modes`, one line each: the test that covers it, or why it cannot
 *    apply. Documents, tests, tooling and configuration owe none. Whether an answer is good is the reviewer's; that none is missing
 *    is this check's (D-178).
 *
 * Run in CI on every pull request; `bun run check:pr <number>` runs it locally.
 */

/** Never about a task's area, and allowed in every task: tests, documents and generated files. */
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
  web: ['apps/web/', 'packages/types/', 'packages/markdown/'],
  api: ['apps/api/', 'packages/types/', 'packages/db/', 'packages/markdown/'],
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

/** `CONTRIBUTING.md` §6.9's categories, in its order, as the pull request template names them. */
export const FAILURE_MODES = [
  'Refused input',
  'Authority',
  'Concurrency',
  'Partial failure',
  'Network and time',
  'Volume',
] as const;

/**
 * The categories with no answer under `## Failure modes`. A comment is not an
 * answer, so the template left as it is answers nothing; a line under another
 * heading does not count either.
 */
export const unansweredFailureModes = (body: string): string[] => {
  // Until nothing changes: removing one comment can join the halves of another.
  let visible = body;
  for (let before = ''; before !== visible;) {
    before = visible;
    visible = visible.replace(/<!--[\s\S]*?-->/g, '');
  }
  const section =
    /^##\s+Failure modes\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(visible)?.[1] ?? '';
  const answers = new Set(
    [
      ...section.matchAll(/^[ \t]*(?:[-*][ \t]+)?\**([^:*\n]+?)\**[ \t]*:\**[ \t]*([^\s*].*)$/gm),
    ].map((match) => (match[1] ?? '').trim().toLowerCase()),
  );
  return FAILURE_MODES.filter((mode) => !answers.has(mode.toLowerCase()));
};

/** The code a person uses: what §6.9's bad day happens to. Tooling and configuration owe none. */
const touchesTheProduct = (file: ChangedFile): boolean =>
  /^(apps|packages)\//.test(file.path) && !unmetered(file.path);

/** Every rule the pull request breaks, in words a person can act on; empty when it passes. */
export const judge = (
  pull: PullRequest,
  issueLabels: ReadonlyMap<number, readonly string[]>,
): string[] => {
  const problems: string[] = [];

  const issues = linkedIssues(pull.body);
  if (issues.length === 0) {
    problems.push(
      'It names no issue. Say "Closes #n", or "Part of #n" for a task that takes several pull requests.',
    );
  }

  const unanswered = pull.files.some(touchesTheProduct) ? unansweredFailureModes(pull.body) : [];
  if (unanswered.length > 0) {
    problems.push(
      `It does not say how it fails: nothing under "## Failure modes" for ${unanswered.join(', ')}. One line each — the test that covers it, or why it cannot apply (CONTRIBUTING.md §6.9).`,
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
