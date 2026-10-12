/**
 * Workspaces and the membership row that carries ownership.
 *
 * **Ownership is `workspace_members.role = 'owner'`, never a column on the
 * workspace.** An owner column makes the owning account permanently undeletable,
 * which becomes a legal problem the first time somebody asks to be erased
 * (D-22).
 *
 * Every read below takes a `WorkspaceContext` rather than an id: the caller
 * cannot have one without having passed the membership guard, so an unscoped
 * read does not compile (D-21).
 *
 * The executor is an argument, so a caller can hand in a transaction and a test
 * can roll one back (D-46).
 *
 * **Invariant I-2 — every workspace keeps at least one owner — is established
 * here and guarded elsewhere.** Creation makes the creator an owner, and that is
 * tested. Nothing in Phase 0 can then break it: changing a role and removing a
 * member are both Phase 1 (`API.md` §3). The guard belongs with those endpoints,
 * where it can be tested against something that actually tries.
 */
import type { Executor, Transaction } from '@purlay/db';
import type { MeResponse, Membership, Workspace, WorkspaceMember } from '@purlay/types';
import { AppError } from '../../platform/errors';
import type { Clock } from '../../platform/clock';
import type { WorkspaceContext } from '../../platform/tenancy';

/** The database speaks snake_case; the wire speaks camelCase. Mapped here, once. */
interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly avatar_url: string | null;
}

const asWorkspace = (row: WorkspaceRow): Workspace => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  avatarUrl: row.avatar_url,
});

export interface NewWorkspace {
  readonly name: string;
  readonly slug: string;
}

/**
 * Creates a workspace and makes its creator the owner, **in one statement each
 * inside the caller's transaction**.
 *
 * The two writes cannot be allowed to separate: a workspace with no owner
 * violates I-2 and cannot be recovered through any Phase 0 endpoint, because
 * every one of them requires a membership that does not exist. The caller passes
 * a transaction — the type refuses the pool — and this does not open one, so the
 * boundary stays where the caller can see it (D-46).
 */
export const createWorkspace = async (
  executor: Transaction,
  clock: Clock,
  creatorId: string,
  input: NewWorkspace,
): Promise<Workspace> => {
  const taken = await executor
    .selectFrom('workspaces')
    .select('id')
    .where('slug', '=', input.slug)
    .executeTakeFirst();
  if (taken !== undefined) {
    // A slug is an identifier in a URL, so this is a name the caller can change,
    // not an internal collision to retry.
    throw new AppError({
      code: 'WORKSPACE_SLUG_TAKEN',
      message: 'That workspace address is already in use.',
    });
  }

  const row = await executor
    .insertInto('workspaces')
    .values({ name: input.name, slug: input.slug, created_by: creatorId })
    .returning(['id', 'name', 'slug', 'avatar_url'])
    .executeTakeFirstOrThrow();

  await executor
    .insertInto('workspace_members')
    .values({
      workspace_id: row.id,
      user_id: creatorId,
      role: 'owner',
      joined_at: clock.now(),
    })
    .execute();

  return asWorkspace(row);
};

/**
 * The workspaces this user belongs to.
 *
 * Not scoped by a `WorkspaceContext`, and it does not need to be: the filter
 * *is* the user, and the answer is the set of workspaces they could obtain a
 * context for.
 */
export const membershipsOf = async (
  executor: Executor,
  clock: Clock,
  userId: string,
): Promise<readonly Membership[]> => {
  const now = clock.now();
  const rows = await executor
    .selectFrom('workspace_members')
    .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
    .select([
      'workspaces.id',
      'workspaces.name',
      'workspaces.slug',
      'workspaces.avatar_url',
      'workspace_members.role',
      'workspace_members.joined_at',
      'workspace_members.is_deep_work_active',
      'workspace_members.deep_work_until',
    ])
    .where('workspace_members.user_id', '=', userId)
    .where('workspaces.deleted_at', 'is', null)
    .orderBy('workspace_members.joined_at', 'asc')
    .execute();

  return rows.map((row) => ({
    workspace: asWorkspace(row),
    role: row.role,
    joinedAt: new Date(row.joined_at).toISOString(),
    // Over when its instant has passed: ended by the clock, with no job to end it (D-108).
    deepWorkUntil:
      row.is_deep_work_active && row.deep_work_until !== null && new Date(row.deep_work_until) > now
        ? new Date(row.deep_work_until).toISOString()
        : null,
  }));
};

/**
 * Who this user is, and what they belong to: the only shape that carries an
 * email address, and only ever to its owner (`models.ts`).
 */
export const meOf = async (
  executor: Executor,
  clock: Clock,
  userId: string,
): Promise<MeResponse> => {
  const user = await executor
    .selectFrom('users')
    .select(['id', 'username', 'display_name', 'avatar_url', 'email'])
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();

  return {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      email: user.email,
    },
    memberships: [...(await membershipsOf(executor, clock, userId))],
  };
};

/** The workspace the context was minted for. There is no other one it could return. */
export const workspaceIn = async (
  executor: Executor,
  context: WorkspaceContext,
): Promise<Workspace> => {
  const row = await executor
    .selectFrom('workspaces')
    .select(['id', 'name', 'slug', 'avatar_url'])
    .where('id', '=', context.workspaceId)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  return asWorkspace(row);
};

/** Everyone in the workspace, as the rest of it may see them — never their email. */
export const membersIn = async (
  executor: Executor,
  context: WorkspaceContext,
): Promise<readonly WorkspaceMember[]> => {
  const rows = await executor
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select([
      'users.id',
      'users.username',
      'users.display_name',
      'users.avatar_url',
      'workspace_members.role',
      'workspace_members.joined_at',
    ])
    .where('workspace_members.workspace_id', '=', context.workspaceId)
    .where('users.deleted_at', 'is', null)
    .orderBy('workspace_members.joined_at', 'asc')
    .execute();

  return rows.map((row) => ({
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
    },
    role: row.role,
    joinedAt: new Date(row.joined_at).toISOString(),
  }));
};
