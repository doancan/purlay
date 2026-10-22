/**
 * Who may make a workspace on this instance (D-155).
 *
 * Signing in is open — an invited person has to be able to — so making a workspace is the door a
 * stranger who finds the address would otherwise walk through, with a storage quota of their own
 * (#633). The operator names who may — GitHub logins, or anybody — in the server's setting
 * (`modules/setup/settings.ts`, D-179 §6), seeded once from `WORKSPACE_CREATORS`. By default nobody may
 * but the first person to sign in, and only while the instance has no workspace — which is how the
 * one-command install still ends with its operator in a workspace of their own (D-144).
 *
 * A login is matched against `users.github_login`: the login as GitHub last gave it, written on every
 * GitHub sign-in (`identity.ts`) — never the username, which takes a `-N` when the name is already
 * somebody's here, or an email link's address (D-169). An account made by an email link has no login.
 */
import { sql, type Executor, type Transaction } from '@purlay/db';
import { AppError } from '../../platform/errors';

export type WorkspaceCreators =
  | { readonly kind: 'anyone' }
  | { readonly kind: 'listed'; readonly logins: ReadonlySet<string> }
  | { readonly kind: 'first' };

/**
 * The rule `WORKSPACE_CREATORS` says, already checked by the configuration's pattern: what the first
 * start copies into the server's setting, and nothing after (D-179 §6).
 */
export const workspaceCreatorsOf = (value: string | undefined): WorkspaceCreators => {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return { kind: 'first' };
  if (trimmed === '*') return { kind: 'anyone' };
  return {
    kind: 'listed',
    logins: new Set(trimmed.split(',').map((login) => login.trim().toLowerCase())),
  };
};

/** Two first workspaces asked for at once take turns, so only one of them is the first. */
const FIRST_WORKSPACE_LOCK = 'workspace-creation:first';

/** Whether the caller is the earliest living account and no workspace exists yet. */
const isFirstOnEmptyInstance = async (executor: Executor, userId: string): Promise<boolean> => {
  // Any row, deleted or not: an instance that has had a workspace is past its first run.
  const any = await executor.selectFrom('workspaces').select('id').limit(1).executeTakeFirst();
  if (any !== undefined) return false;
  const first = await executor
    .selectFrom('users')
    .select('id')
    .where('deleted_at', 'is', null)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .limit(1)
    .executeTakeFirst();
  return first?.id === userId;
};

/** Whether this person may make a workspace now — what `GET /api/me` tells the client. */
export const mayCreateWorkspace = async (
  executor: Executor,
  creators: WorkspaceCreators,
  userId: string,
): Promise<boolean> => {
  switch (creators.kind) {
    case 'anyone':
      return true;
    case 'first':
      return await isFirstOnEmptyInstance(executor, userId);
    case 'listed': {
      const user = await executor
        .selectFrom('users')
        .select('github_login')
        .where('id', '=', userId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      // No login: an email link's account, or one GitHub has since given its login to another.
      const login = user?.github_login ?? null;
      return login !== null && creators.logins.has(login.toLowerCase());
    }
  }
};

/**
 * Refuses, with `403 FORBIDDEN`, a person this server does not let make a workspace. Inside the
 * transaction that makes it: for the first workspace, two at once are serialised on a lock, so the
 * second reads the first's commit and is refused.
 */
export const requireMayCreateWorkspace = async (
  transaction: Transaction,
  creators: WorkspaceCreators,
  userId: string,
): Promise<void> => {
  if (creators.kind === 'first') {
    await sql`select pg_advisory_xact_lock(hashtextextended(${FIRST_WORKSPACE_LOCK}, 0))`.execute(
      transaction,
    );
  }
  if (!(await mayCreateWorkspace(transaction, creators, userId))) {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'This server does not let you make a workspace. Ask for an invitation.',
    });
  }
};
