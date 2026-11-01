/**
 * What GitHub says of work a thread points at, applied (D-246 §3): the title and state of an issue or pull request
 * as its signed events arrive, and the thread told when what it shows changed.
 *
 * - **Never a message, never a notification.** A state change is shown on the root and told to the people who have
 *   its thread open (`THREAD_UPDATED`); it counts as unread for nobody and notifies nobody, so the notification
 *   levels and Deep Work (D-12, D-15, D-134 §7) are respected by there being nothing to respect. Resolving the
 *   question stays an explicit act of a person (D-204).
 * - **Out of order, and again, is nothing.** Each link keeps the instant GitHub last changed the item (`state_at`,
 *   GitHub's own `updated_at`); an event older than it is dropped, so a late delivery cannot move a link back. An
 *   event that says what the link already says only moves that instant: nothing is written that shows, and nobody
 *   is told — repeated state updates coalesce into the one the person sees.
 * - **Only for the workspaces the installation is.** A link is updated by a delivery for the installation its
 *   workspace connected, never another's, whatever repository the payload names.
 */
import { sql, type Executor } from '@purlay/db';
import type { ThreadSummary } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import {
  publication,
  publishAfterCommit,
  publishThreadUpdated,
  type EventBus,
} from '../../platform/events';
import type { Logger } from '../../platform/logging';
import { readBuilt } from '../messages/reader';

/** One thread that has something new to show, told once its change has committed. */
export interface ThreadNotice {
  readonly channelId: string;
  readonly rootId: string;
  readonly thread: ThreadSummary;
  readonly version: number;
}

/** The root's state version moved and its thread read as it now is: what a client is told to replace. */
export const announce = async (
  transaction: Executor,
  channelId: string,
  rootId: string,
): Promise<ThreadNotice> => {
  const root = await transaction
    .updateTable('messages')
    .set({ state_version: sql<number>`state_version + 1` })
    .where('id', '=', rootId)
    .returning('state_version')
    .executeTakeFirstOrThrow();
  const message = await readBuilt(transaction, rootId);
  if (message?.thread == null) throw new Error('a root with GitHub work has no thread');
  return { channelId, rootId, thread: message.thread, version: root.state_version };
};

/** Tells the rooms, after the change is committed; a publish that fails is written, never thrown over the write. */
export const tell = async (
  dependencies: { readonly bus: EventBus; readonly clock: Clock; readonly log: Logger },
  notices: readonly ThreadNotice[],
): Promise<void> => {
  await publishAfterCommit(
    dependencies.log,
    notices.map((notice) => [
      publication('THREAD_UPDATED', () =>
        publishThreadUpdated(
          dependencies.bus,
          dependencies.clock,
          { channelId: notice.channelId, messageId: notice.rootId, thread: notice.thread },
          notice.version,
        ),
      ),
    ]),
  );
};

/** What an event says of an item. */
export interface ItemEvent {
  readonly installationId: number;
  readonly repositoryId: number;
  readonly kind: 'issue' | 'pull';
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed' | 'merged';
  /** GitHub's own instant for the item: what orders events, never when this server heard them. */
  readonly updatedAt: Date;
}

/** Applies one event to every link of the item, in the workspaces of the installation; the threads that changed. */
export const applyItemEvent = async (
  transaction: Executor,
  event: ItemEvent,
): Promise<readonly ThreadNotice[]> => {
  const rows = await transaction
    .selectFrom('github_links')
    .select(['id', 'channel_id', 'root_id', 'title', 'state', 'state_at'])
    .where('repository_id', '=', String(event.repositoryId))
    .where('kind', '=', event.kind)
    .where('number', '=', event.number)
    .where('workspace_id', 'in', (eb) =>
      eb
        .selectFrom('github_app_installations')
        .select('workspace_id')
        .where('installation_id', '=', String(event.installationId)),
    )
    .orderBy('id')
    .forUpdate()
    .execute();
  const notices: ThreadNotice[] = [];
  const title = event.title.slice(0, 256);
  for (const row of rows) {
    // Older than what is shown, or the same instant again: GitHub said it before.
    if (new Date(row.state_at).getTime() >= event.updatedAt.getTime()) continue;
    await transaction
      .updateTable('github_links')
      .set({ title, state: event.state, state_at: event.updatedAt })
      .where('id', '=', row.id)
      .execute();
    // The same thing said later is not news: the instant moved, and what the thread shows did not.
    if (row.title === title && row.state === event.state) continue;
    notices.push(await announce(transaction, row.channel_id, row.root_id));
  }
  return notices;
};
