/**
 * A repository's feeds into a channel (#79, D-134): set up, listed and removed by an owner or an
 * admin, from a channel they can see — the channel guard has already said they can, and a role is
 * not a way round it (D-123 §2). A direct message has none, and is answered as no channel at all.
 *
 * Each feed's secret is made here, sealed by the one cipher with the feed's id bound in (D-39 §6),
 * and handed back in the answer that made it, never again. What the audit trail records is the
 * repository, never the secret.
 */
import { Value } from '@sinclair/typebox/value';
import type { Executor, Transaction } from '@purlay/db';
import {
  GITHUB_FEEDS_PER_CHANNEL_MAX,
  GitHubFeedEventName,
  GitHubFeedFailure,
  Uuid,
  type CreateGitHubFeedRequest,
  type CreatedGitHubFeed,
  type GitHubFeed,
  type GitHubFeedList,
} from '@purlay/types';
import { channelNotFound, type ChannelContext } from '../../platform/channels';
import type { Clock } from '../../platform/clock';
import type { CredentialCipher } from '../../platform/crypto';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { recordAudit } from '../audit/audit';

const feedNotFound = (): AppError =>
  new AppError({ code: 'GITHUB_FEED_NOT_FOUND', message: 'Feed not found.' });

/**
 * The role read again inside the caller's transaction, through the guard: a demotion that committed
 * first is the answer, and it is this workspace's role, never another membership's.
 */
const mayConfigure = async (executor: Executor, context: ChannelContext): Promise<void> => {
  if (context.channelType === 'direct_message') throw channelNotFound();
  const { role } = await requireWorkspaceMembership(executor, context.userId, context.workspaceId);
  if (role === 'member') {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Only an owner or an admin connects a repository to a channel.',
    });
  }
};

interface FeedRow {
  readonly id: string;
  readonly channel_id: string;
  readonly repository_full_name: string;
  readonly events: string[];
  readonly created_at: Date | string;
  readonly last_delivery_at: Date | string | null;
  readonly last_failure: string | null;
  readonly last_failure_at: Date | string | null;
}

const iso = (at: Date | string): string => new Date(at).toISOString();

/** A row as the contract says it; a value the table's checks let through and the contract does not is a bug, said. */
const feedOf = (row: FeedRow): GitHubFeed => {
  const events = row.events.filter((name) => Value.Check(GitHubFeedEventName, name));
  const reason = row.last_failure;
  if (
    events.length !== row.events.length ||
    (reason !== null && !Value.Check(GitHubFeedFailure, reason))
  ) {
    throw new Error(`github_repo_feeds ${row.id} holds a value the contract does not know`);
  }
  return {
    id: row.id,
    channelId: row.channel_id,
    repository: row.repository_full_name,
    events,
    createdAt: iso(row.created_at),
    lastDeliveryAt: row.last_delivery_at === null ? null : iso(row.last_delivery_at),
    lastFailure:
      reason === null || row.last_failure_at === null
        ? null
        : { reason, at: iso(row.last_failure_at) },
  };
};

const COLUMNS = [
  'id',
  'channel_id',
  'repository_full_name',
  'events',
  'created_at',
  'last_delivery_at',
  'last_failure',
  'last_failure_at',
] as const;

/** `GET /api/channels/:channelId/github-feeds` — oldest first, bounded by the cap. */
export const channelFeeds = async (
  executor: Executor,
  context: ChannelContext,
): Promise<GitHubFeedList> => {
  await mayConfigure(executor, context);
  const rows = await executor
    .selectFrom('github_repo_feeds')
    .select(COLUMNS)
    .where('channel_id', '=', context.channelId)
    .orderBy('created_at')
    .orderBy('id')
    .limit(GITHUB_FEEDS_PER_CHANNEL_MAX)
    .execute();
  return rows.map(feedOf);
};

/**
 * Connects a repository. The channel's row is locked first, so two admins connecting at once take
 * turns: the second sees the first's feed, and the cap counts both.
 */
export const createFeed = async (
  transaction: Transaction,
  clock: Clock,
  cipher: CredentialCipher,
  context: ChannelContext,
  request: CreateGitHubFeedRequest,
): Promise<CreatedGitHubFeed> => {
  await mayConfigure(transaction, context);
  const live = await transaction
    .selectFrom('channels')
    .select('id')
    .where('id', '=', context.channelId)
    .where('deleted_at', 'is', null)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (live === undefined) throw channelNotFound();
  const repository = request.repository.toLowerCase();
  const existing = await transaction
    .selectFrom('github_repo_feeds')
    .select('repository_full_name')
    .where('channel_id', '=', context.channelId)
    .execute();
  if (existing.some((row) => row.repository_full_name === repository)) {
    throw new AppError({
      code: 'GITHUB_FEED_EXISTS',
      message: 'This channel already hears from that repository.',
    });
  }
  if (existing.length >= GITHUB_FEEDS_PER_CHANNEL_MAX) {
    throw new AppError({
      code: 'GITHUB_FEEDS_LIMIT',
      message: `A channel hears from ${String(GITHUB_FEEDS_PER_CHANNEL_MAX)} repositories at most.`,
    });
  }
  const id = crypto.randomUUID();
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  const sealed = Buffer.from(await cipher.seal(secret, id)).toString('base64');
  const row = await transaction
    .insertInto('github_repo_feeds')
    .values({
      id,
      workspace_id: context.workspaceId,
      channel_id: context.channelId,
      repository_full_name: repository,
      events: [...request.events],
      secret_encrypted: sealed,
      created_by: context.userId,
      created_at: clock.now(),
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  await recordAudit(transaction, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'integration.feed_created',
    targetType: 'integration',
    targetId: id,
    metadata: { repository },
  });
  return { feed: feedOf(row), webhookPath: `/api/webhooks/github/${id}`, secret };
};

/** `DELETE /api/channels/:channelId/github-feeds/:feedId` — disconnected; its secret goes with it. */
export const removeFeed = async (
  transaction: Transaction,
  clock: Clock,
  context: ChannelContext,
  feedId: string,
): Promise<void> => {
  await mayConfigure(transaction, context);
  // Not an id at all is the same as no such feed — never a database error.
  if (!Value.Check(Uuid, feedId)) throw feedNotFound();
  const removed = await transaction
    .deleteFrom('github_repo_feeds')
    .where('id', '=', feedId)
    .where('channel_id', '=', context.channelId)
    .returning('repository_full_name')
    .executeTakeFirst();
  if (removed === undefined) throw feedNotFound();
  await recordAudit(transaction, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'integration.feed_removed',
    targetType: 'integration',
    targetId: feedId,
    metadata: { repository: removed.repository_full_name },
  });
};
