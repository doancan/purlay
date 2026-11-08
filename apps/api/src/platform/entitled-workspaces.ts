/**
 * The workspaces a module may act for now, as a statement the database answers (D-289 §9): the SQL form of `effectiveModules`,
 * written once, so that a worker, a scheduled job and a sweep of a module's own rows all ask the one question and a workspace that
 * loses a grant, or a module the administrator stops (D-296), drops out of the next page and the next statement. The TS function is
 * the specification; `entitled-workspaces.integration.test.ts` holds the two to the same answer over every combination of grant.
 *
 * **A loop that acts for workspaces is written `perWorkspace(visit)`**, so the framework walks the workspaces and the module's code
 * is only ever called with one it may serve; the build refuses a worker or a job of a module that is a grant that is not written
 * so (`unguardedWorkProblem`, `composition.ts`). The data's lifecycle is exempt and does not use any of this: retention, purge,
 * erasure and both exports cover a module's rows whoever is granted it (`entitlements/hooks.ts`).
 */
import { sql, type Executor } from '@purlay/db';
import { readGrants } from './grants';
import type {
  EffectiveModulesInput,
  EntitlementCandidate,
  EntitlementPolicy,
} from './module-kit/entitlement';
import type { WorkspaceScope } from './ports/record-ref';

/** Workspaces read at a time: a page is one statement and one read of the grants, however many workspaces there are. */
export const ENTITLED_PAGE_SIZE = 100;

/** What the composition knows once and every module's view shares. */
export interface EntitledSources {
  readonly running: readonly EntitlementCandidate[];
  readonly mode: EffectiveModulesInput['mode'];
  /** The modules the administrator has stopped, as of the moment of the question. */
  readonly suspended: () => ReadonlySet<string>;
  readonly effective: EntitlementPolicy['effective'];
}

/** A condition for a `where`: what `sql` makes of a statement that answers true or false. */
type Condition = ReturnType<typeof sql<boolean>>;

export interface EntitledWorkspaces {
  /**
   * A condition on a column that holds a workspace id (`'tasks.workspace_id'`): true when the module may act for that workspace
   * now. For a statement of the module's own that sweeps its rows across workspaces; it is the predicate `turns` pages by.
   */
  readonly has: (workspaceColumn: string) => Condition;
  /** Up to `limit` workspaces after `after`, in id order, each with the modules it may use; none once the end is reached. */
  readonly turns: (after: string | undefined, limit: number) => Promise<readonly WorkspaceScope[]>;
}

/** `module` and what it requires, directly or through others, among the modules this process runs; `undefined` if one is not run. */
const closureOf = (
  module: string,
  running: readonly EntitlementCandidate[],
): readonly EntitlementCandidate[] | undefined => {
  const byId = new Map(running.map((candidate) => [candidate.id, candidate]));
  const closure = new Map<string, EntitlementCandidate>();
  const pending = [module];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    const candidate = byId.get(id);
    if (candidate === undefined) return undefined;
    if (closure.has(id)) continue;
    closure.set(id, candidate);
    pending.push(...candidate.requires);
  }
  return [...closure.values()];
};

/** The grant of one module to the workspace in `column`, as `granted` in `entitlement.ts` reads it: `off` wins, an end counts, then the mode. */
const grantedSql = (column: string, module: string, mode: EntitledSources['mode']): Condition => {
  const row = (state: 'on' | 'off'): ReturnType<typeof sql> => sql`select 1 from workspace_modules g
    where g.workspace_id = ${sql.ref(column)} and g.module = ${module}
      and ${state === 'on' ? sql`g.state = 'on'` : sql`g.state <> 'on'`}
      and (g.valid_until is null or g.valid_until > now())`;
  return sql<boolean>`(not exists (${row('off')}) and (${mode === 'open'} or exists (${row('on')})))`;
};

export const entitledWorkspaces = (
  module: string,
  sources: EntitledSources,
  database: Executor,
): EntitledWorkspaces => {
  const has: EntitledWorkspaces['has'] = (column) => {
    const closure = closureOf(module, sources.running);
    const suspended = sources.suspended();
    if (closure === undefined || closure.some(({ id }) => suspended.has(id)))
      return sql<boolean>`false`;
    const conditions = closure
      .filter(({ entitlement }) => entitlement !== 'always')
      .map(({ id }) => grantedSql(column, id, sources.mode));
    return conditions.length === 0
      ? sql<boolean>`true`
      : sql<boolean>`(${sql.join(conditions, sql` and `)})`;
  };
  return {
    has,
    turns: async (after, limit): Promise<readonly WorkspaceScope[]> => {
      // Judged by the database's clock, as the guard's read is, so the page and a request agree on a grant's end.
      const found = await database
        .selectFrom('workspaces')
        .select(['id', sql<Date>`now()`.as('read_at')])
        .where('deleted_at', 'is', null)
        .$if(after !== undefined, (query) => query.where('id', '>', after ?? ''))
        .where(has('workspaces.id'))
        .orderBy('id')
        .limit(limit)
        .execute();
      const grants = await readGrants(
        database,
        found.map(({ id }) => id),
      );
      return found.map(({ id, read_at }) => ({
        workspaceId: id,
        modules: sources.effective(grants.get(id) ?? [], read_at),
      }));
    },
  };
};

/** A module's view bound to the database of whoever asks, as `PortsFor` is: what the composition gives whoever starts work. */
export type EntitledFor = (module: string, database: Executor) => EntitledWorkspaces;

/** No workspace is entitled: what work gets where the process has no composition to ask (a test of one module's pieces). */
export const noEntitledWorkspaces: EntitledWorkspaces = {
  has: () => sql<boolean>`false`,
  turns: () => Promise.resolve([]),
};

/** Visits each workspace the module may act for, a page at a time; the pages are read as the walk goes, so a grant lost meanwhile is not served. */
export const eachEntitled = async (
  entitled: EntitledWorkspaces,
  visit: (turn: WorkspaceScope) => Promise<void>,
): Promise<void> => {
  for (let after: string | undefined; ;) {
    const page = await entitled.turns(after, ENTITLED_PAGE_SIZE);
    for (const turn of page) await visit(turn);
    const last = page.at(-1);
    if (last === undefined || page.length < ENTITLED_PAGE_SIZE) return;
    after = last.workspaceId;
  }
};

const perWorkspaceWork = new WeakSet<object>();

/**
 * Records that `work` was made by `perWorkspaceWorker` or `perWorkspaceJob`, which walk `eachEntitled` themselves: the only way a
 * function gets in, so that `isPerWorkspace` is a fact about the function and not a claim of its author.
 */
export const markPerWorkspace = <Work extends object>(work: Work): Work => {
  perWorkspaceWork.add(work);
  return work;
};

export const isPerWorkspace = (work: object): boolean => perWorkspaceWork.has(work);
