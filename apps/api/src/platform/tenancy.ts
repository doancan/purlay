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
import { Uuid, type GuestMembershipAccess, type UserRole } from '@purlay/types';
import type { Executor } from '@purlay/db';
import { AppError, routeNotFound } from './errors';
import { currentRequest } from './logging';
import { asGrants, grantColumns } from './grants';
import { inTheCore } from './module-budget';
import { activeWorkspaceMembership } from './membership-access';

export { activeWorkspaceMembership } from './membership-access';

/** Not exported. Naming this key is the capability, and it stays in this file. */
const tenancy: unique symbol = Symbol('WorkspaceContext');

/**
 * Every context the guard has minted, by identity. The brand above is a plain property, so `{ ...mine, workspaceId }` copies
 * it and type-checks; a copy is a new object and is not in this set. Not exported: only the guard can add to it.
 */
const minted = new WeakSet<object>();

const mint = (context: Omit<WorkspaceContext, typeof tenancy>): WorkspaceContext => {
  const sealed: WorkspaceContext = Object.freeze({ ...context, [tenancy]: true as const });
  minted.add(sealed);
  return sealed;
};

/**
 * Refuses a context the guard did not mint (a spread, a copy, a hand-made object), loudly: a port that takes a context and
 * writes with it as its workspace and its actor calls this first, since the type cannot tell a copy from the original (D-250).
 */
export const assertMinted: (context: WorkspaceContext) => void = (context) => {
  if (!minted.has(context)) {
    throw new Error(
      'a WorkspaceContext that the membership guard did not mint was refused: contexts are not copied or built by hand',
    );
  }
};

export interface WorkspaceContext {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: UserRole;
  /** Restricted authority, independent of the mutable read/unread scope. Absent for existing members. */
  readonly guest?: GuestMembershipAccess;
  /**
   * The modules this workspace may use, as the guard read the grants (D-289): what search, the inbox, the ports, the workers and
   * the outbox are asked, so that none of them works the set out again. `null` for a request made with no policy to judge by
   * (a command, a test), which is unrestricted.
   */
  readonly modules: ReadonlySet<string> | null;
  readonly [tenancy]: true;
}

/**
 * Whether the workspace of a context may use a module (D-289): what a service asks when the module it serves is not the
 * request's own, as the workspace-wide find and the inbox are the core's and speak for several. True when nothing judged the
 * grants (`modules` is `null`).
 */
export const entitledTo = (context: WorkspaceContext, module: string): boolean =>
  context.modules === null || context.modules.has(module);

/** Guest capabilities never inherit the workspace-wide actions of the ordinary member role. */
export const requireFullMembership = (
  context: Pick<WorkspaceContext, 'guest'>,
  message: string,
): void => {
  if (context.guest !== undefined) throw new AppError({ code: 'FORBIDDEN', message });
};

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
 *
 * **Then the grant (D-289).** The workspace's grants are read in the same statement, so they are of the same snapshot as the
 * membership and no node can hold them stale. A request of a module the workspace is not granted is turned away as a path
 * nobody has, which is what a module that is not run answers. It is asked after the membership and not before: a person who is
 * not a member learns nothing of a workspace, its grants included. The guard is the one place that mints a context, so a module
 * cannot forget to ask.
 */
const workspaceMembership = async (
  executor: Executor,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceContext> => {
  if (!Value.Check(Uuid, workspaceId)) throw workspaceNotFound();

  const row = await executor
    .selectFrom('workspace_members')
    .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
    .select([
      'workspace_members.role',
      'workspace_members.access_kind',
      'workspace_members.guest_since',
      'workspace_members.guest_expires_at',
      'workspace_members.guest_modules',
      ...grantColumns,
    ])
    .where('workspace_members.workspace_id', '=', workspaceId)
    .where('workspace_members.user_id', '=', userId)
    .where('workspaces.deleted_at', 'is', null)
    .where(activeWorkspaceMembership)
    .executeTakeFirst();

  if (row === undefined) throw workspaceNotFound();

  const request = currentRequest();
  const policy = request?.entitlements;
  const granted = policy?.effective(asGrants(row.grants), row.read_at) ?? null;
  let guest: GuestMembershipAccess | undefined;
  let modules = granted;
  if (row.access_kind === 'guest') {
    if (row.guest_since === null || row.guest_modules === null) throw workspaceNotFound();
    guest = {
      kind: 'guest',
      historySince: new Date(row.guest_since).toISOString(),
      expiresAt:
        row.guest_expires_at === null ? null : new Date(row.guest_expires_at).toISOString(),
    };
    modules = new Set(
      row.guest_modules.filter((module) => granted === null || granted.has(module)),
    );
  }
  if (request?.module !== undefined && modules !== null && !modules.has(request.module)) {
    policy?.refused(request.module);
    throw routeNotFound();
  }
  return mint({
    workspaceId,
    userId,
    role: row.role,
    modules,
    ...(guest === undefined ? {} : { guest }),
  });
};

/** The guard above as the core's own work, whichever module's request asks it (`inTheCore`, D-266). */
export const requireWorkspaceMembership = inTheCore(workspaceMembership);

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
const deletionMembership = async (
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

/** The guard above as the core's own work, as `requireWorkspaceMembership` is. */
export const requireDeletionMembership = inTheCore(deletionMembership);
