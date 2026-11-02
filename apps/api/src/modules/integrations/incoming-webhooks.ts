/**
 * A channel's incoming webhooks (D-245): an address a CI job or a monitor posts a message to, under the
 * hook's name, with no session.
 *
 * Made, listed and revoked by an owner or an admin, from a channel they can see, as a repository's feed is
 * (D-134 §2): the channel guard has already said they can, and a role is not a way round it. A direct
 * message has none, and is answered as no channel at all.
 *
 * The secret is made here and handed back once, in the path the answer carries; what is kept is its
 * digest (`platform/tokens.ts`), so a copy of the database posts nothing. A post finds the hook by its id
 * and compares the digest in constant time; an id nobody made, a wrong secret, a hook revoked, its channel
 * archived or its workspace deleted are one `404`, so the address says nothing to whoever guesses at it.
 *
 * What a hook posts is nobody's message, as a feed's event is (D-134 §6): no sender, counted unread for
 * everybody, needing nobody — its words are never read for `@` (D-12) — and it arrives by the path a
 * person's does (`publishArrival`). Every post is one log line — the hook and the outcome, never the
 * secret or the words.
 */
import { Value } from '@sinclair/typebox/value';
import type { Executor, Transaction } from '@purlay/db';
import {
  INCOMING_WEBHOOKS_PER_CHANNEL_MAX,
  IncomingWebhookName,
  Uuid,
  messageId,
  type CreateIncomingWebhookRequest,
  type CreatedIncomingWebhook,
  type IncomingWebhook,
  type IncomingWebhookList,
} from '@purlay/types';
import { channelNotFound, type ChannelContext } from '../../platform/channels';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { EventBus } from '../../platform/events';
import type { Logger } from '../../platform/logging';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { digestsEqual, randomToken, tokenDigest } from '../../platform/tokens';
import { atomicallyOn } from '../../platform/transactions';
import { recordAudit } from '../audit/audit';
import { countArrival } from '../messages/delivery';
import { publishArrival } from '../messages/messages';
import { readBuilt } from '../messages/reader';

/** What a message a hook posted holds as its metadata: the kind `messages_event_known` knows, and the name. */
const INCOMING_WEBHOOK_KIND = 'incoming_webhook';

const hookNotFound = (): AppError =>
  new AppError({ code: 'INCOMING_WEBHOOK_NOT_FOUND', message: 'Webhook not found.' });

/**
 * The role read again inside the caller's transaction, through the guard: a demotion that committed
 * first is the answer, and it is this workspace's role, never another membership's.
 */
const mayConfigure = async (executor: Executor, context: ChannelContext): Promise<void> => {
  if (context.channelType === 'direct_message') throw channelNotFound();
  const { role } = await requireWorkspaceMembership(executor, context.userId, context.workspaceId);
  // Each role decided, so a role added later is refused until somebody says otherwise.
  switch (role) {
    case 'owner':
    case 'admin':
      return;
    case 'member':
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'Only an owner or an admin manages a channel’s incoming webhooks.',
      });
  }
};

interface HookRow {
  readonly id: string;
  readonly channel_id: string;
  readonly name: string;
  readonly created_at: Date | string;
  readonly last_used_at: Date | string | null;
  readonly creator_id: string | null;
  readonly creator_username: string | null;
  readonly creator_display_name: string | null;
  readonly creator_avatar_url: string | null;
}

const iso = (at: Date | string): string => new Date(at).toISOString();

const webhookOf = (row: HookRow): IncomingWebhook => ({
  id: row.id,
  channelId: row.channel_id,
  name: row.name,
  createdBy:
    row.creator_id === null || row.creator_username === null || row.creator_display_name === null
      ? null
      : {
          id: row.creator_id,
          username: row.creator_username,
          displayName: row.creator_display_name,
          avatarUrl: row.creator_avatar_url,
        },
  createdAt: iso(row.created_at),
  lastUsedAt: row.last_used_at === null ? null : iso(row.last_used_at),
});

/** A channel's hooks, oldest first and bounded by the cap, or the one hook named — with who made each. */
const hookRows = async (
  executor: Executor,
  which: { readonly channelId: string } | { readonly webhookId: string },
): Promise<HookRow[]> =>
  await executor
    .selectFrom('incoming_webhooks')
    .leftJoin('users', 'users.id', 'incoming_webhooks.created_by')
    .select([
      'incoming_webhooks.id',
      'incoming_webhooks.channel_id',
      'incoming_webhooks.name',
      'incoming_webhooks.created_at',
      'incoming_webhooks.last_used_at',
      'users.id as creator_id',
      'users.username as creator_username',
      'users.display_name as creator_display_name',
      'users.avatar_url as creator_avatar_url',
    ])
    .where((eb) =>
      'channelId' in which
        ? eb('incoming_webhooks.channel_id', '=', which.channelId)
        : eb('incoming_webhooks.id', '=', which.webhookId),
    )
    .orderBy('incoming_webhooks.created_at')
    .orderBy('incoming_webhooks.id')
    .limit(INCOMING_WEBHOOKS_PER_CHANNEL_MAX)
    .execute();

/** `GET /api/channels/:channelId/incoming-webhooks` — oldest first, bounded by the cap. */
export const channelWebhooks = async (
  executor: Executor,
  context: ChannelContext,
): Promise<IncomingWebhookList> => {
  await mayConfigure(executor, context);
  return (await hookRows(executor, { channelId: context.channelId })).map(webhookOf);
};

/**
 * Makes a hook. The channel's row is locked first, so two admins making one at once take turns: the
 * second sees the first's, and the cap counts both.
 */
export const createWebhook = async (
  transaction: Transaction,
  clock: Clock,
  context: ChannelContext,
  request: CreateIncomingWebhookRequest,
): Promise<CreatedIncomingWebhook> => {
  await mayConfigure(transaction, context);
  const live = await transaction
    .selectFrom('channels')
    .select('id')
    .where('id', '=', context.channelId)
    .where('deleted_at', 'is', null)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (live === undefined) throw channelNotFound();
  const { count } = await transaction
    .selectFrom('incoming_webhooks')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('channel_id', '=', context.channelId)
    .executeTakeFirstOrThrow();
  if (Number(count) >= INCOMING_WEBHOOKS_PER_CHANNEL_MAX) {
    throw new AppError({
      code: 'INCOMING_WEBHOOKS_LIMIT',
      message: `A channel has ${String(INCOMING_WEBHOOKS_PER_CHANNEL_MAX)} incoming webhooks at most.`,
    });
  }
  const id = crypto.randomUUID();
  const secret = randomToken();
  await transaction
    .insertInto('incoming_webhooks')
    .values({
      id,
      workspace_id: context.workspaceId,
      channel_id: context.channelId,
      name: request.name,
      secret_digest: await tokenDigest(secret),
      created_by: context.userId,
      created_at: clock.now(),
    })
    .execute();
  const [row] = await hookRows(transaction, { webhookId: id });
  if (row === undefined) throw new Error(`incoming webhook ${id} was written and is not there`);
  await recordAudit(transaction, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'integration.webhook_created',
    targetType: 'integration',
    targetId: id,
    // Where, as well as what, as a feed's entry says (#691); never the secret.
    metadata: { name: request.name, channelId: context.channelId },
  });
  return { webhook: webhookOf(row), path: `/api/webhooks/incoming/${id}/${secret}` };
};

/** `DELETE /api/channels/:channelId/incoming-webhooks/:webhookId` — revoked: its address posts nothing again. */
export const revokeWebhook = async (
  transaction: Transaction,
  clock: Clock,
  context: ChannelContext,
  webhookId: string,
): Promise<void> => {
  await mayConfigure(transaction, context);
  // Not an id at all is the same as no such hook — never a database error.
  if (!Value.Check(Uuid, webhookId)) throw hookNotFound();
  const removed = await transaction
    .deleteFrom('incoming_webhooks')
    .where('id', '=', webhookId)
    .where('channel_id', '=', context.channelId)
    .returning('name')
    .executeTakeFirst();
  if (removed === undefined) throw hookNotFound();
  await recordAudit(transaction, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'integration.webhook_revoked',
    targetType: 'integration',
    targetId: webhookId,
    metadata: { name: removed.name, channelId: context.channelId },
  });
};

export interface IncomingPostDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly log: Logger;
  /** Whether this hook may post once more now: its own bucket, charged once its secret held. */
  readonly mayPost: (webhookId: string) => Promise<boolean>;
}

export interface IncomingPost {
  readonly webhookId: string;
  readonly secret: string;
  /** The message's words, already held to the contract (`IncomingWebhookPost`). */
  readonly text: string;
}

interface LiveHook {
  readonly id: string;
  readonly workspace_id: string;
  readonly channel_id: string;
  readonly name: string;
  readonly secret_digest: string;
}

/**
 * The hook, if it may post: in a channel not archived, of a workspace not deleted (`tenancy.ts`). Either
 * gone is the hook not there.
 */
const liveHook = async (executor: Executor, webhookId: string): Promise<LiveHook | undefined> =>
  await executor
    .selectFrom('incoming_webhooks')
    .innerJoin('channels', 'channels.id', 'incoming_webhooks.channel_id')
    .innerJoin('workspaces', 'workspaces.id', 'incoming_webhooks.workspace_id')
    .select([
      'incoming_webhooks.id',
      'incoming_webhooks.workspace_id',
      'incoming_webhooks.channel_id',
      'incoming_webhooks.name',
      'incoming_webhooks.secret_digest',
    ])
    .where('incoming_webhooks.id', '=', webhookId)
    .where('channels.deleted_at', 'is', null)
    .where('workspaces.deleted_at', 'is', null)
    .executeTakeFirst();

/** `POST /api/webhooks/incoming/:webhookId/:secret` — the message posted, by its id. */
export const receivePost = async (
  dependencies: IncomingPostDependencies,
  post: IncomingPost,
): Promise<string> => {
  const { database, clock, log, mayPost } = dependencies;
  // Digested before anything is looked up, so a wrong secret and a hook nobody made cost the same work.
  const presented = await tokenDigest(post.secret);
  // Not an id at all is the same as no such hook — never a database error.
  const hook = Value.Check(Uuid, post.webhookId)
    ? await liveHook(database, post.webhookId)
    : undefined;
  if (hook === undefined || !digestsEqual(presented, hook.secret_digest)) {
    // Anybody can cause one: said in the log by its outcome alone, never the address that was tried.
    log.info('incoming webhook', { outcome: 'not_found' });
    throw hookNotFound();
  }
  // The name is the table's, which the contract bounds the same way; one it cannot say is a bug, said.
  if (!Value.Check(IncomingWebhookName, hook.name)) {
    throw new Error(`incoming_webhooks ${hook.id} has a name the contract cannot say`);
  }
  if (!(await mayPost(hook.id))) {
    log.warn('incoming webhook', { webhookId: hook.id, outcome: 'rate_limited' });
    throw new AppError({ code: 'RATE_LIMITED', message: 'Too many posts. Slow down.' });
  }

  const now = clock.now();
  const posted = await atomicallyOn(database)(async (transaction) => {
    // Marked used first: the row lock it takes makes a revocation racing this post wait for it, or win
    // outright — then there is no row, and nothing is posted.
    const used = await transaction
      .updateTable('incoming_webhooks')
      .set({ last_used_at: now })
      .where('id', '=', hook.id)
      .returning('id')
      .executeTakeFirst();
    if (used === undefined) return null;
    const id = messageId(now);
    await transaction
      .insertInto('messages')
      .values({
        id,
        workspace_id: hook.workspace_id,
        channel_id: hook.channel_id,
        sender_id: null,
        message_type: 'system_event',
        metadata: { kind: INCOMING_WEBHOOK_KIND, name: hook.name },
        content: post.text,
        created_at: now,
      })
      .execute();
    // Unread for everybody, and needing nobody: a hook names nobody and tells nobody (D-245).
    const recipients = await countArrival(
      transaction,
      hook.channel_id,
      { id, reply: false },
      null,
      [],
    );
    await transaction
      .updateTable('channels')
      .set({ last_message_at: now })
      .where('id', '=', hook.channel_id)
      .where((eb) => eb.or([eb('last_message_at', 'is', null), eb('last_message_at', '<', now)]))
      .execute();
    const message = await readBuilt(transaction, id);
    if (message === undefined) throw new Error(`post ${id} was written and is not there`);
    return { message, recipients };
  });
  if (posted === null) {
    log.info('incoming webhook', { webhookId: hook.id, outcome: 'not_found' });
    throw hookNotFound();
  }
  await publishArrival(
    { bus: dependencies.bus, clock, log },
    hook.channel_id,
    posted.message,
    null,
    posted.recipients,
  );
  log.info('incoming webhook', { webhookId: hook.id, outcome: 'posted' });
  return posted.message.id;
};
