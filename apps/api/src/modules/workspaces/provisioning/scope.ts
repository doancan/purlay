/** A source projection can run only under this native transaction's workspace mutex. */
import type { Transaction } from '@purlay/db';
import { workspaceNotFound } from '../../../platform/tenancy';

const locked: unique symbol = Symbol('WorkspaceProjectionScope');
const transactions = new WeakMap<object, Transaction>();
const changes = new WeakMap<
  object,
  { changed: boolean; users: Set<string>; revoked: Map<string, Set<string>>; sessions: Set<string> }
>();

export interface WorkspaceProjectionScope {
  readonly workspaceId: string;
  readonly [locked]: true;
}

/** Native integration calls this before its first directory subject mutation, never after it. */
export const lockWorkspaceProjectionScope = async (
  transaction: Transaction,
  workspaceId: string,
): Promise<WorkspaceProjectionScope> => {
  const workspace = await transaction
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', workspaceId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (workspace === undefined) throw workspaceNotFound();
  const scope: WorkspaceProjectionScope = Object.freeze({ workspaceId, [locked]: true as const });
  transactions.set(scope, transaction);
  changes.set(scope, { changed: false, users: new Set(), revoked: new Map(), sessions: new Set() });
  return scope;
};

export const noteWorkspaceAccessChange = (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
  userIds: readonly string[] = [],
): void => {
  requireWorkspaceProjectionScope(transaction, scope);
  const journal = changes.get(scope);
  if (journal === undefined) throw new Error('Workspace access change has no native scope.');
  journal.changed = true;
  for (const id of userIds) journal.users.add(id);
};

export const noteWorkspaceChannelRevocation = (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
  userId: string,
  channelIds: readonly string[],
): void => {
  noteWorkspaceAccessChange(transaction, scope, [userId]);
  const journal = changes.get(scope);
  if (journal === undefined) throw new Error('Channel revocation has no native scope.');
  const held = journal.revoked.get(userId) ?? new Set<string>();
  for (const id of channelIds) held.add(id);
  journal.revoked.set(userId, held);
};

export const noteCompanySessionsEnded = (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
  sessionIds: readonly string[],
): void => {
  noteWorkspaceAccessChange(transaction, scope);
  const journal = changes.get(scope);
  if (journal === undefined) throw new Error('Company-session revocation has no native scope.');
  for (const id of sessionIds) journal.sessions.add(id);
};

/** Copy while the native transaction is active; the post-commit effect retains only immutable IDs. */
export const workspaceAccessOutcome = (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
): {
  readonly changed: boolean;
  readonly workspaceId: string;
  readonly userIds: readonly string[];
  readonly revoked: readonly { readonly userId: string; readonly channelIds: readonly string[] }[];
  readonly endedCompanySessionIds: readonly string[];
} => {
  requireWorkspaceProjectionScope(transaction, scope);
  const journal = changes.get(scope);
  if (journal === undefined) throw new Error('Workspace access outcome has no native scope.');
  return Object.freeze({
    changed: journal.changed,
    workspaceId: scope.workspaceId,
    userIds: Object.freeze([...journal.users].sort()),
    revoked: Object.freeze(
      [...journal.revoked].map(([userId, ids]) =>
        Object.freeze({ userId, channelIds: Object.freeze([...ids].sort()) }),
      ),
    ),
    endedCompanySessionIds: Object.freeze([...journal.sessions].sort()),
  });
};

export const requireWorkspaceProjectionScope = (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
): void => {
  if (transactions.get(scope) !== transaction)
    throw new Error('Workspace projection requires its exact native locked transaction.');
};
