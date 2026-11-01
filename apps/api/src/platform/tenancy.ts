/**
 * Tenant isolation, as a type.
 *
 * The rule *every workspace-scoped query filters on `workspace_id`* fails
 * eventually if it depends on remembering, and D-21 singles this out as the only
 * defect class here that is silent, unbounded and unrecoverable: a slow query
 * gets noticed, a leaked message does not and cannot be un-leaked. So it is made
 * structural (`ARCHITECTURE.md` §7.3).
 *
 * `WorkspaceContext` carries a brand keyed by a symbol this module does not
 * export. Nothing outside this file can name that key, so nothing outside this
 * file can build a value of the type — the only way to obtain one is to pass
 * through the guard, and the guard only returns after it has seen the
 * `workspace_members` row. A workspace-scoped repository takes one as its first
 * argument, so an unscoped query does not compile.
 *
 * The brand is not `readonly __brand: unique symbol` as such a type is usually
 * written. That form is uninhabited: it type-checks as a declaration and then
 * nothing — including this module — can produce a value satisfying it without an
 * assertion, which would put the escape hatch inside the mechanism. A symbol-keyed
 * property is constructible here and nowhere else. (D-54)
 *
 * The remaining hole is a deliberate `as WorkspaceContext`, which no type system
 * closes. Lint closes it: the assertion is banned repository-wide, with no
 * exemption, and `scripts/verify-enforcement.ts` proves the ban by writing one.
 */
import { Value } from '@sinclair/typebox/value';
import { Uuid, type UserRole } from '@purlay/types';
import type { Executor } from '@purlay/db';
import { AppError } from './errors';

/** Not exported. Naming this key is the capability, and it stays in this file. */
const tenancy: unique symbol = Symbol('WorkspaceContext');

export interface WorkspaceContext {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: UserRole;
  readonly [tenancy]: true;
}

/**
 * **404, never 403.** A 403 confirms the resource exists, which is itself a
 * disclosure (D-21).
 *
 * Both refusals below are this one value. "No such workspace" and "not your
 * workspace" are indistinguishable because they are the same object, not because
 * two branches were kept in step.
 */
export const workspaceNotFound = (): AppError =>
  new AppError({ code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found.' });

/**
 * Verifies membership and mints the context. The only producer of one.
 *
 * `executor` is an argument — a `Kysely` or a `Transaction`, indistinguishable
 * here — so this runs inside a rolled-back transaction in a test (D-46).
 *
 * The id is checked for shape before it reaches the database. Without that, a
 * path parameter that is not a UUID makes PostgreSQL raise, and the boundary
 * answers 500 where it promised 404 — an oracle separating malformed ids from
 * missing ones, and a category of response the contract does not have.
 *
 * A soft-deleted workspace is not a workspace you are a member of: the join
 * requires `deleted_at IS NULL`, so a membership row that outlives its workspace
 * mints nothing.
 */
export const requireWorkspaceMembership = async (
  executor: Executor,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceContext> => {
  if (!Value.Check(Uuid, workspaceId)) throw workspaceNotFound();

  const row = await executor
    .selectFrom('workspace_members')
    .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
    .select('workspace_members.role')
    .where('workspace_members.workspace_id', '=', workspaceId)
    .where('workspace_members.user_id', '=', userId)
    .where('workspaces.deleted_at', 'is', null)
    .executeTakeFirst();

  if (row === undefined) throw workspaceNotFound();

  return { workspaceId, userId, role: row.role, [tenancy]: true };
};

/** Not exported either: the deletion's own capability, apart from the workspace's. */
const deletion: unique symbol = Symbol('DeletionContext');

/**
 * A membership as a workspace's deletion is asked for and taken back under (D-242). Not a
 * `WorkspaceContext`: it is minted for a workspace the guard above refuses, and nothing else can be
 * reached with it.
 */
export interface DeletionContext {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: UserRole;
  readonly [deletion]: true;
}

/**
 * Verifies membership of a workspace that is live **or whose deletion was asked for** and is not yet
 * erased — the one state the guard above refuses on purpose, since its owners must still be able to take
 * it back, and a repeated request must answer as the first did (D-33). The deletion's two routes are its
 * only callers. Once the erasure is done its memberships are gone with everything else, and this is the
 * same `404` as any stranger's.
 */
export const requireDeletionMembership = async (
  executor: Executor,
  userId: string,
  workspaceId: string,
): Promise<DeletionContext> => {
  if (!Value.Check(Uuid, workspaceId)) throw workspaceNotFound();

  const row = await executor
    .selectFrom('workspace_members')
    .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
    .select('workspace_members.role')
    .where('workspace_members.workspace_id', '=', workspaceId)
    .where('workspace_members.user_id', '=', userId)
    .where('workspaces.purged_at', 'is', null)
    .executeTakeFirst();

  if (row === undefined) throw workspaceNotFound();

  return { workspaceId, userId, role: row.role, [deletion]: true };
};
