/**
 * `bun run check:pr <number>` — the pull-request rules (`check-pull-request.ts`)
 * applied to one pull request, with what they need read through `gh`.
 *
 * CI runs it on every pull request with the number from the event. It refuses
 * rather than passes when it cannot read the pull request: a check that could
 * not look reports nothing about the change (`CONTRIBUTING.md` §6.4).
 */
import { judge, type ChangedFile, linkedIssues } from './check-pull-request';

/**
 * `gh`, with three tries. GitHub answers a 504 now and then — measured while
 * running this against merged pull requests — and a transient error at GitHub
 * must not fail a change; a persistent one still does, loudly.
 */
const gh = (args: readonly string[]): unknown => {
  let stderr = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode === 0) return JSON.parse(result.stdout.toString()) as unknown;
    stderr = result.stderr.toString();
    Bun.sleepSync(attempt * 1_000);
  }
  console.error(`gh ${args.join(' ')} failed three times:\n${stderr}`);
  process.exit(1);
};

const number = process.argv[2];
if (number === undefined || !/^\d+$/.test(number)) {
  console.error('usage: bun run check:pr <pull request number>');
  process.exit(1);
}

const pull = gh(['pr', 'view', number, '--json', 'body,author,labels,files']) as {
  body: string;
  author: { login: string };
  labels: { name: string }[];
  files: { path: string; additions: number; deletions: number }[];
};

const issueLabels = new Map<number, string[]>();
for (const issue of linkedIssues(pull.body)) {
  const found = gh(['issue', 'view', String(issue), '--json', 'labels']) as {
    labels: { name: string }[];
  };
  issueLabels.set(
    issue,
    found.labels.map((label) => label.name),
  );
}

const files: ChangedFile[] = pull.files.map((file) => ({
  path: file.path,
  additions: file.additions,
  deletions: file.deletions,
}));
const problems = judge(
  {
    body: pull.body,
    author: pull.author.login,
    labels: pull.labels.map((label) => label.name),
    files,
  },
  issueLabels,
);

if (problems.length > 0) {
  console.error(`#${number} does not pass:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(
  `#${number} names ${String(issueLabels.size)} issue(s), fits the budget, and touches what they are about`,
);
