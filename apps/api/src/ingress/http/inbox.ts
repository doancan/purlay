/**
 * The core's inbox over HTTP (D-286): `GET` and `POST …/read` of `/api/workspaces/:workspaceId/inbox`, the caller's own
 * notices from the modules this process runs. The core's routes, not a module's: they answer in a process that runs no
 * module, with nothing to list.
 */
import { InboxQuery, MarkInboxReadRequest, type InboxPage } from '@purlay/types';
import type { Executor } from '@purlay/db';
import { requireLiveSession } from '../../modules/auth/sessions';
import type { Auth } from '../../modules/auth/better-auth';
import { inboxPage, markInboxRead } from '../../modules/inbox/inbox';
import type { Clock } from '../../platform/clock';
import { inboxUpdatedPublications, publishAfterCommit, type EventBus } from '../../platform/events';
import type { Logger } from '../../platform/logging';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn, snapshotOn } from '../../platform/transactions';
import { requireSession } from './session';
import { queryOf, validated } from './validate';

export interface InboxDependencies {
  readonly auth: Auth;
  readonly database: Executor;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly log: Logger;
  /** The ids of the modules this process runs: a notice of any other is kept and not shown. */
  readonly running: readonly string[];
}

/** `GET /api/workspaces/:workspaceId/inbox?unreadOnly=&before=&limit=` */
export const listInbox = async (
  { auth, database, running }: InboxDependencies,
  request: Request,
  workspaceId: string,
): Promise<InboxPage> => {
  const { userId } = await requireSession(auth, request);
  const query = validated(
    InboxQuery,
    queryOf(new URL(request.url), { numbers: ['limit'], booleans: ['unreadOnly'] }),
  );
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await snapshotOn(database)(
    async (transaction) => await inboxPage(transaction, context, running, query),
  );
};

/** `POST /api/workspaces/:workspaceId/inbox/read` — `204`; the caller's other tabs are told to read the inbox again. */
export const readInbox = async (
  { auth, database, clock, bus, log, running }: InboxDependencies,
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<void> => {
  const { userId, sessionId } = await requireSession(auth, request);
  const input = validated(MarkInboxReadRequest, body);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const read = await atomicallyOn(database)(async (transaction) => {
    await requireLiveSession(transaction, clock, sessionId);
    return await markInboxRead(transaction, clock, context, running, input);
  });
  if (read === 0) return;
  await publishAfterCommit(log, [inboxUpdatedPublications(bus, clock, workspaceId, [userId])]);
};
