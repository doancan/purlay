/**
 * What to work on next, derived rather than maintained.
 *
 * `Ready` means startable now: in the current milestone, and every issue it
 * depends on is closed. That was set by hand once, which meant it was wrong the
 * moment something merged. The dependencies live in the issue bodies as
 * `Blocked by #N`, this reads them, and the board's Status is computed from
 * them — the same argument D-45 makes about the database types, one layer up.
 *
 *   bun run queue            print the queue
 *   bun run queue --apply    also write Status back to the project board
 */
const OWNER = 'doancan';
const REPO = 'purlay';
const PROJECT = 1;

interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'OPEN' | 'CLOSED';
  readonly milestone: { readonly title: string } | null;
  readonly labels: readonly { readonly name: string }[];
}

const gh = (args: readonly string[]): string => {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
};

const issues = JSON.parse(
  gh([
    'issue',
    'list',
    '-R',
    `${OWNER}/${REPO}`,
    '--state',
    'all',
    '--limit',
    '400',
    '--json',
    'number,title,body,state,milestone,labels',
  ]),
) as Issue[];

const byNumber = new Map(issues.map((i) => [i.number, i]));
const closed = (n: number): boolean => byNumber.get(n)?.state === 'CLOSED';

/** `> **Blocked by** #4 · #12` — one line, in the issue body, next to the work. */
const blockersOf = (issue: Issue): number[] => {
  const line = /\*\*Blocked by\*\*(.+)/.exec(issue.body)?.[1] ?? '';
  return [...line.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
};

/** The lowest version that still has open work. Milestones are versions (D-32). */
const currentMilestone = (): string => {
  const open = issues.filter((i) => i.state === 'OPEN' && i.milestone !== null);
  const titles = [...new Set(open.map((i) => i.milestone?.title ?? ''))].filter(Boolean);
  titles.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return titles[0] ?? '';
};

const milestone = currentMilestone();
const isEpic = (i: Issue): boolean => i.body.startsWith('> **Epic**');

const inScope = issues.filter(
  (i) => i.state === 'OPEN' && i.milestone?.title === milestone && !isEpic(i),
);

const ready: Issue[] = [];
const blocked: { issue: Issue; on: number[] }[] = [];
for (const issue of inScope) {
  const open = blockersOf(issue).filter((n) => !closed(n));
  if (open.length === 0) ready.push(issue);
  else blocked.push({ issue, on: open });
}

ready.sort((a, b) => a.number - b.number);

console.log(
  `\nMilestone ${milestone} — ${String(inScope.length)} open, ${String(ready.length)} startable now\n`,
);
console.log('READY');
for (const i of ready) {
  const labels = i.labels.map((l) => l.name).join(' ');
  console.log(`  #${String(i.number).padEnd(4)} ${i.title}`);
  console.log(`        ${labels}`);
}
console.log(`\nBLOCKED (${String(blocked.length)})`);
for (const { issue, on } of blocked.sort((a, b) => a.issue.number - b.issue.number)) {
  console.log(`  #${String(issue.number).padEnd(4)} ${issue.title}`);
  console.log(`        waiting on ${on.map((n) => `#${String(n)}`).join(', ')}`);
}

if (!process.argv.includes('--apply')) {
  console.log('\n(--apply also writes Status back to the board)');
  process.exit(0);
}

interface FieldOption {
  readonly id: string;
  readonly name: string;
}
interface Field {
  readonly id: string;
  readonly name: string;
  readonly options?: FieldOption[];
}
const project = JSON.parse(
  gh([
    'api',
    'graphql',
    '-f',
    `query=query{user(login:"${OWNER}"){projectV2(number:${String(PROJECT)}){id
    fields(first:30){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}`,
  ]),
) as { data: { user: { projectV2: { id: string; fields: { nodes: Field[] } } } } };

const projectId = project.data.user.projectV2.id;
const status = project.data.user.projectV2.fields.nodes.find((f) => f.name === 'Status');
if (!status?.options) throw new Error('the board has no Status field');
const optionId = (name: string): string => {
  const found = status.options?.find((o) => o.name === name);
  if (!found) throw new Error(`Status has no option ${name}`);
  return found.id;
};

const items = new Map<number, string>();
let cursor: string | null = null;
for (;;) {
  const page = JSON.parse(
    gh([
      'api',
      'graphql',
      '-f',
      `query=query{user(login:"${OWNER}"){projectV2(number:${String(PROJECT)}){
      items(first:100${cursor === null ? '' : `,after:"${cursor}"`}){pageInfo{hasNextPage endCursor}
      nodes{id content{... on Issue{number}}}}}}}`,
    ]),
  ) as {
    data: {
      user: {
        projectV2: {
          items: {
            pageInfo: { hasNextPage: boolean; endCursor: string };
            nodes: { id: string; content?: { number?: number } }[];
          };
        };
      };
    };
  };
  const { nodes, pageInfo } = page.data.user.projectV2.items;
  for (const node of nodes) {
    if (node.content?.number !== undefined) items.set(node.content.number, node.id);
  }
  if (!pageInfo.hasNextPage) break;
  cursor = pageInfo.endCursor;
}

let changed = 0;
const write = (issue: Issue, want: 'Ready' | 'Backlog'): void => {
  const itemId = items.get(issue.number);
  if (itemId === undefined) return;
  gh([
    'api',
    'graphql',
    '-f',
    `query=mutation{updateProjectV2ItemFieldValue(input:{projectId:"${projectId}",
        itemId:"${itemId}",fieldId:"${status.id}",value:{singleSelectOptionId:"${optionId(want)}"}}){
        projectV2Item{id}}}`,
  ]);
  changed += 1;
};
for (const issue of ready) write(issue, 'Ready');
for (const { issue } of blocked) write(issue, 'Backlog');
console.log(`\nboard updated: ${String(changed)} items`);
