/**
 * Saved messages through HTTP (#484, D-128): save, move, let go, and the lists. Each is the
 * caller's own; a change tells only their own tabs (`SAVED_UPDATED`), after the commit.
 */
import { SaveMessageRequest, SavedQuery, type SavedIds, type SavedPage } from '@purlay/types';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishSavedUpdated,
} from '../../platform/events';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { saveMessage, savedIds, savedPage, unsaveMessage } from '../../modules/saved/saved';
import type { ChannelDependencies, ChannelWriteDependencies } from './channels';
import { requireSession } from './session';
import { queryOf, validated } from './validate';

const told = async (
  { bus, clock, log = NO_LOG }: ChannelWriteDependencies,
  userId: string,
  workspaceId: string,
): Promise<void> => {
  await publishAfterCommit(log, [
    [publication('SAVED_UPDATED', () => publishSavedUpdated(bus, clock, userId, workspaceId))],
  ]);
};

/** `PUT /api/messages/:messageId/saved` — saved, or moved to a state; the same answer again. */
export const putSaved = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  messageId: string,
  body: unknown,
): Promise<void> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const input = validated(SaveMessageRequest, body ?? {});
  const workspaceId = await atomicallyOn(database)(
    async (transaction) => await saveMessage(transaction, clock, userId, messageId, input),
  );
  await told(dependencies, userId, workspaceId);
};

/** `DELETE /api/messages/:messageId/saved` — let go; letting go of nothing is the same 204. */
export const deleteSaved = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  messageId: string,
): Promise<void> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const workspaceId = await unsaveMessage(database, userId, messageId);
  await told(dependencies, userId, workspaceId);
};

/** `GET /api/workspaces/:workspaceId/saved?state=` — one state's saves, newest first. */
export const listSaved = async (
  { auth, database }: ChannelDependencies,
  request: Request,
  workspaceId: string,
): Promise<SavedPage> => {
  const { userId } = await requireSession(auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const input = validated(SavedQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await savedPage(database, context, input);
};

/** `GET /api/workspaces/:workspaceId/saved/ids` — which messages are saved, to mark them. */
export const listSavedIds = async (
  { auth, database }: ChannelDependencies,
  request: Request,
  workspaceId: string,
): Promise<SavedIds> => {
  const { userId } = await requireSession(auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await savedIds(database, context);
};
