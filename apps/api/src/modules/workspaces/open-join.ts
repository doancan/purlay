/**
 * Open join: the one way a second person enters a workspace in Phase 0.
 *
 * Phase 0 ends when two different GitHub users exchange a message, and no Phase 0
 * endpoint can put a second user into a workspace — invitations are Phase 1, and
 * joining a channel already requires membership. `WORKSPACE_OPEN_JOIN_SLUG` names
 * one workspace; a user who signs in and is not yet in it is added as `member`.
 * Unset, the instance is closed. (D-37)
 *
 * Named by slug rather than "the first workspace", because "the first" is an
 * ordering nobody chose and it changes as soon as there are two.
 */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';

/** What signing in did. Every outcome is a success: none of them may block sign-in. */
export type OpenJoin = 'joined' | 'already a member' | 'no such workspace';

/**
 * Adds the user to the open workspace, unless they are in it already.
 *
 * **Never changes an existing membership.** The owner signing in again stays the
 * owner: a conflict on the membership row does nothing, rather than writing
 * `member` over whatever role is there. Demoting the last owner would break I-2
 * through an endpoint that is not about roles at all.
 *
 * **A slug with no workspace is not an error.** It is the expected state before
 * the operator has created the workspace — they sign in first and create it
 * second — so sign-in must not fail on it. The boot notice is what tells an
 * operator which state they are in.
 */
export const joinOpenWorkspace = async (
  executor: Executor,
  clock: Clock,
  slug: string,
  userId: string,
): Promise<OpenJoin> => {
  const workspace = await executor
    .selectFrom('workspaces')
    .select('id')
    .where('slug', '=', slug)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (workspace === undefined) return 'no such workspace';

  const inserted = await executor
    .insertInto('workspace_members')
    .values({ workspace_id: workspace.id, user_id: userId, role: 'member', joined_at: clock.now() })
    .onConflict((conflict) => conflict.columns(['workspace_id', 'user_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return inserted === undefined ? 'already a member' : 'joined';
};

/**
 * The line the process prints at boot, in both states.
 *
 * Printed when the instance is closed too: an operator reading the log should
 * not have to infer the state from a line that is absent. An instance that quietly
 * accepts anyone with a GitHub account is not something to discover by accident
 * (D-37, `CONFIG.md`).
 */
export const openJoinNotice = (slug: string | undefined): string =>
  slug === undefined
    ? 'open join: off — a user enters a workspace only by creating one (WORKSPACE_OPEN_JOIN_SLUG is unset)'
    : `open join: ON — anyone who signs in with GitHub is added as a member of the workspace "${slug}". ` +
      'If no workspace has that slug yet, whoever first creates one with it will own the workspace everyone joins.';
