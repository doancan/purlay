/**
 * A root's GitHub work (D-246): the issues and pull requests a thread points at, read for a whole page in one
 * query and shaped as the contract says. A record the channel reads — the title and state as GitHub last said
 * them — and never a permission: it is read by whoever may read the root, installation or no.
 *
 * The address is built from the repository's name and the item's number, never taken from GitHub's words, as a
 * card's is (D-23): a link a person wrote or GitHub sent cannot name another place.
 */
import type { Executor } from '@purlay/db';
import { GITHUB_WORK_PER_THREAD_MAX, type GitHubWorkLink } from '@purlay/types';

interface WorkRow {
  readonly id: string;
  readonly repository_full_name: string;
  readonly kind: string;
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly origin: string;
}

const kindOf = (kind: string): GitHubWorkLink['kind'] => {
  if (kind === 'issue' || kind === 'pull') return kind;
  // The table's check refuses anything else; a row past it is a defect, said loudly.
  throw new Error('github_links.kind holds an unknown value');
};

const stateOf = (state: string): GitHubWorkLink['state'] => {
  if (state === 'open' || state === 'closed' || state === 'merged') return state;
  throw new Error('github_links.state holds an unknown value');
};

/** One row, as the contract says it. */
export const workLinkOf = (row: WorkRow): GitHubWorkLink => {
  const kind = kindOf(row.kind);
  return {
    id: row.id,
    repository: row.repository_full_name,
    kind,
    number: row.number,
    title: row.title,
    state: stateOf(row.state),
    origin: row.origin === 'created' ? 'created' : 'linked',
    url: `https://github.com/${row.repository_full_name}/${kind === 'pull' ? 'pull' : 'issues'}/${String(row.number)}`,
  };
};

/** The work of these roots, oldest first, at most `GITHUB_WORK_PER_THREAD_MAX` each; a root with none is not in the map. */
export const githubWorkFor = async (
  executor: Executor,
  rootIds: readonly string[],
): Promise<ReadonlyMap<string, readonly GitHubWorkLink[]>> => {
  const found = new Map<string, GitHubWorkLink[]>();
  if (rootIds.length === 0) return found;
  const rows = await executor
    .selectFrom('github_links')
    .select(['id', 'root_id', 'repository_full_name', 'kind', 'number', 'title', 'state', 'origin'])
    .where('root_id', 'in', rootIds)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  for (const row of rows) {
    const links = found.get(row.root_id) ?? [];
    if (links.length < GITHUB_WORK_PER_THREAD_MAX) links.push(workLinkOf(row));
    found.set(row.root_id, links);
  }
  return found;
};
