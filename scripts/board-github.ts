/**
 * Every call the board scripts make to GitHub, in one place.
 *
 * `board-rules.ts` decides; this reads and writes. It is exercised against the
 * real repository (a fake of `gh` would only test the fake), and the callers take
 * its functions as parameters so their own tests need no network.
 */
import type { BoardIssue, Stage } from './board-rules';

export const OWNER = 'doancan';
export const REPO = 'purlay';
export const PROJECT = 1;

const PAGE = 100;

export const gh = (args: readonly string[]): string => {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
};

export const currentUser = (): string => gh(['api', 'user', '--jq', '.login']).trim();

interface Page<T> {
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
  readonly nodes: readonly T[];
}

/** Runs a query that returns one connection at `path`, and follows its cursor to the end. */
const connection = <T>(query: string, pick: (data: unknown) => Page<T>): T[] => {
  const nodes: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    if (cursor !== null) args.push('-f', `after=${cursor}`);
    const page = pick(JSON.parse(gh(args)));
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) return nodes;
    cursor = page.pageInfo.endCursor;
  }
};

interface IssueNode {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'OPEN' | 'CLOSED';
  readonly updatedAt: string;
  readonly milestone: { readonly title: string } | null;
  readonly labels: { readonly nodes: readonly { readonly name: string }[] };
  readonly assignees: { readonly nodes: readonly { readonly login: string }[] };
}

const ISSUE_FIELDS = `number title body state updatedAt milestone{title}
  labels(first:30){nodes{name}} assignees(first:10){nodes{login}}`;

const toBoardIssue = (node: IssueNode, closing: readonly number[]): BoardIssue => ({
  number: node.number,
  title: node.title,
  body: node.body,
  state: node.state,
  milestone: node.milestone?.title ?? null,
  labels: node.labels.nodes.map((l) => l.name),
  assignees: node.assignees.nodes.map((a) => a.login),
  closingPullRequests: closing,
  updatedAt: node.updatedAt,
});

interface PullNode {
  readonly number: number;
  readonly closingIssuesReferences: { readonly nodes: readonly { readonly number: number }[] };
}

/** Open pull requests, as: issue number → the pull requests that would close it. */
const openClosers = (): Map<number, number[]> => {
  const pulls = connection<PullNode>(
    `query($after:String){repository(owner:"${OWNER}",name:"${REPO}"){
      pullRequests(states:OPEN,first:${String(PAGE)},after:$after){pageInfo{hasNextPage endCursor}
      nodes{number closingIssuesReferences(first:20){nodes{number}}}}}}`,
    (data) =>
      (data as { data: { repository: { pullRequests: Page<PullNode> } } }).data.repository
        .pullRequests,
  );
  const closers = new Map<number, number[]>();
  for (const pull of pulls) {
    for (const { number } of pull.closingIssuesReferences.nodes) {
      closers.set(number, [...(closers.get(number) ?? []), pull.number]);
    }
  }
  return closers;
};

/** Every issue, open and closed (closed ones are what a blocker is looked up in). */
export const fetchIssues = (): BoardIssue[] => {
  const closers = openClosers();
  const nodes = connection<IssueNode>(
    `query($after:String){repository(owner:"${OWNER}",name:"${REPO}"){
      issues(first:${String(PAGE)},after:$after){pageInfo{hasNextPage endCursor}
      nodes{${ISSUE_FIELDS}}}}}`,
    (data) =>
      (data as { data: { repository: { issues: Page<IssueNode> } } }).data.repository.issues,
  );
  return nodes.map((node) => toBoardIssue(node, closers.get(node.number) ?? []));
};

/** A fresh read of one issue: a claim decides on this, not on the list it fetched earlier. */
export const fetchIssue = (number: number): BoardIssue => {
  const data = JSON.parse(
    gh([
      'api',
      'graphql',
      '-f',
      `query=query{repository(owner:"${OWNER}",name:"${REPO}"){issue(number:${String(number)}){${ISSUE_FIELDS}}}}`,
    ]),
  ) as { data: { repository: { issue: IssueNode | null } } };
  const node = data.data.repository.issue;
  if (node === null) throw new Error(`there is no issue #${String(number)}`);
  return toBoardIssue(node, openClosers().get(number) ?? []);
};

export const assign = (number: number, user: string): void => {
  gh(['issue', 'edit', String(number), '-R', `${OWNER}/${REPO}`, '--add-assignee', user]);
};

export const unassign = (number: number, user: string): void => {
  gh(['issue', 'edit', String(number), '-R', `${OWNER}/${REPO}`, '--remove-assignee', user]);
};

interface ItemNode {
  readonly id: string;
  readonly content: { readonly number?: number } | null;
  readonly fieldValueByName: { readonly name: string } | null;
}

interface StatusField {
  readonly id: string;
  readonly name: string;
  readonly options?: readonly { readonly id: string; readonly name: string }[];
}

const PROJECT_REF = `user(login:"${OWNER}"){projectV2(number:${String(PROJECT)})`;

/** Writes the stages to the board's Status, skipping items already showing it. Returns how many changed. */
export const writeStages = (stages: ReadonlyMap<number, Stage>): number => {
  const head = JSON.parse(
    gh([
      'api',
      'graphql',
      '-f',
      `query=query{${PROJECT_REF}{id fields(first:30){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}`,
    ]),
  ) as { data: { user: { projectV2: { id: string; fields: { nodes: StatusField[] } } } } };
  const { id: projectId, fields } = head.data.user.projectV2;
  const status = fields.nodes.find((f) => f.name === 'Status');
  if (!status?.options) throw new Error('the board has no Status field');
  const optionId = (name: Stage): string => {
    const found = status.options?.find((o) => o.name === name);
    if (!found) throw new Error(`Status has no option ${name}`);
    return found.id;
  };

  const items = connection<ItemNode>(
    `query($after:String){${PROJECT_REF}{items(first:${String(PAGE)},after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{id content{... on Issue{number}} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}`,
    (data) =>
      (data as { data: { user: { projectV2: { items: Page<ItemNode> } } } }).data.user.projectV2
        .items,
  );

  let changed = 0;
  for (const item of items) {
    const number = item.content?.number;
    const want = number === undefined ? undefined : stages.get(number);
    if (want === undefined || item.fieldValueByName?.name === want) continue;
    gh([
      'api',
      'graphql',
      '-f',
      `query=mutation{updateProjectV2ItemFieldValue(input:{projectId:"${projectId}",
        itemId:"${item.id}",fieldId:"${status.id}",value:{singleSelectOptionId:"${optionId(want)}"}}){
        projectV2Item{id}}}`,
    ]);
    changed += 1;
  }
  return changed;
};
