/** Channel-scoped outgoing subscriptions and transactional outbox (D-312). */
import { Value } from '@sinclair/typebox/value';
import {
  OUTGOING_WEBHOOKS_MAX,
  WebhookEventType,
  messageId,
  type Message,
  type OutgoingWebhook,
  type OutgoingWebhookRequest,
  type CreatedOutgoingWebhook,
  type WebhookPayload,
  WebhookDeliveryPage,
  type WebhookAttemptList,
} from '@purlay/types';
import type { ChatDb, ChatTx } from '../schema';
import { channelNotFound, requireChannelById, type ChannelContext } from '../channels/guard';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { AppError } from '../../../platform/errors';
import type { CredentialCipher } from '../../../platform/crypto';
import type { Clock } from '../../../platform/clock';
import { randomToken } from '../../../platform/tokens';
import { recordAudit } from '../../../modules/audit/audit';
import { isPublicAddress } from '../../../modules/images/addresses';

const missing = (): AppError =>
  new AppError({ code: 'OUTGOING_WEBHOOK_NOT_FOUND', message: 'Webhook not found.' });
const invalid = (field: string, message: string): AppError =>
  new AppError({ code: 'VALIDATION_FAILED', message, details: { fields: { [field]: message } } });

/** No credentials in URLs, no redirects, no private literals; DNS is checked again at connection time. */
export const webhookTarget = (given: string): URL => {
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw invalid('url', 'Use a public HTTPS address.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    (url.port !== '' && url.port !== '443') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    ((host.includes(':') || /^\d+(\.\d+)*$/.test(host)) && !isPublicAddress(host))
  ) {
    throw invalid(
      'url',
      'Use a public HTTPS address on port 443 without credentials or fragments.',
    );
  }
  return url;
};

/** Inside the mutation transaction: role changes and workspace deletion serialize on the workspace lock. */
const mayManageWebhooks = async (db: ChatDb, context: ChannelContext): Promise<void> => {
  await db
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', context.workspaceId)
    .forKeyShare()
    .execute();
  await requireChannelById(db, context.userId, context.channelId);
  // A private channel membership cannot disappear while its configuration is changed.
  if (context.channelType === 'private') {
    const membership = await db
      .selectFrom('channel_members')
      .select('id')
      .where('channel_id', '=', context.channelId)
      .where('user_id', '=', context.userId)
      .forKeyShare()
      .executeTakeFirst();
    if (membership === undefined) throw channelNotFound();
  }
  // Key-share locks above block authority removal but allow incoming posts' workspace/share
  // and member counter updates. Serialize configuration on the channel without blocking send FKs.
  const live = await db
    .selectFrom('channels')
    .select('id')
    .where('id', '=', context.channelId)
    .where('deleted_at', 'is', null)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (live === undefined) throw channelNotFound();
  await requireChannelById(db, context.userId, context.channelId);
  const member = await requireWorkspaceMembership(db, context.userId, context.workspaceId);
  if (context.channelType === 'direct_message') throw channelNotFound();
  if (member.role === 'member')
    throw new AppError({ code: 'FORBIDDEN', message: 'Only owners and admins manage webhooks.' });
  const channel = await db
    .selectFrom('channels')
    .select('id')
    .where('id', '=', context.channelId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (channel === undefined) throw channelNotFound();
};

const hookOf = (row: {
  id: string;
  channel_id: string;
  name: string;
  url: string;
  events: string[];
  paused: boolean;
  created_at: Date | string;
}): OutgoingWebhook => ({
  id: row.id,
  channelId: row.channel_id,
  name: row.name,
  url: row.url,
  events: row.events.map((event) => {
    if (!Value.Check(WebhookEventType, event)) throw new Error('unknown webhook event');
    return event;
  }),
  paused: row.paused,
  createdAt: new Date(row.created_at).toISOString(),
});

export const listOutgoingWebhooks = async (
  db: ChatDb,
  context: ChannelContext,
): Promise<OutgoingWebhook[]> => {
  await mayManageWebhooks(db, context);
  const rows = await db
    .selectFrom('outgoing_webhooks')
    .selectAll()
    .where('channel_id', '=', context.channelId)
    .where('revoked_at', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    .limit(OUTGOING_WEBHOOKS_MAX)
    .execute();
  return rows.map(hookOf);
};

const ownOutgoingWebhook = async (
  db: ChatDb,
  context: ChannelContext,
  id: string,
): Promise<OutgoingWebhook> => {
  await mayManageWebhooks(db, context);
  const row = await db
    .selectFrom('outgoing_webhooks')
    .selectAll()
    .where('id', '=', id)
    .where('channel_id', '=', context.channelId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (row === undefined) throw missing();
  return hookOf(row);
};

const audit = async (
  db: ChatTx,
  clock: Clock,
  context: ChannelContext,
  id: string,
  operation: string,
): Promise<void> => {
  await recordAudit(db, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'integration.outgoing_webhook_changed',
    targetType: 'integration',
    targetId: id,
    metadata: { channelId: context.channelId, operation },
  });
};

export const createOutgoingWebhook = async (
  db: ChatTx,
  clock: Clock,
  cipher: CredentialCipher,
  context: ChannelContext,
  request: OutgoingWebhookRequest,
): Promise<CreatedOutgoingWebhook> => {
  await mayManageWebhooks(db, context);
  const hooks = await listOutgoingWebhooks(db, context);
  if (hooks.length >= OUTGOING_WEBHOOKS_MAX)
    throw new AppError({
      code: 'OUTGOING_WEBHOOKS_LIMIT',
      message: 'This channel has as many outgoing webhooks as allowed.',
    });
  const url = webhookTarget(request.url).toString();
  const id = crypto.randomUUID();
  const secret = randomToken();
  const row = await db
    .insertInto('outgoing_webhooks')
    .values({
      id,
      workspace_id: context.workspaceId,
      channel_id: context.channelId,
      name: request.name,
      url,
      events: request.events,
      secret_encrypted: Buffer.from(await cipher.seal(secret, id)).toString('base64'),
      created_by: context.userId,
      created_at: clock.now(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(db, clock, context, id, 'created');
  return { webhook: hookOf(row), secret };
};

export const rotateOutgoingWebhook = async (
  db: ChatTx,
  clock: Clock,
  cipher: CredentialCipher,
  context: ChannelContext,
  id: string,
): Promise<CreatedOutgoingWebhook> => {
  const webhook = await ownOutgoingWebhook(db, context, id);
  const secret = randomToken();
  await db
    .updateTable('outgoing_webhooks')
    .set({ secret_encrypted: Buffer.from(await cipher.seal(secret, id)).toString('base64') })
    .where('id', '=', id)
    .execute();
  await audit(db, clock, context, id, 'rotated');
  return { webhook, secret };
};

export const changeOutgoingWebhook = async (
  db: ChatTx,
  clock: Clock,
  context: ChannelContext,
  id: string,
  paused: boolean | 'revoke',
): Promise<void> => {
  await ownOutgoingWebhook(db, context, id);
  await db
    .updateTable('outgoing_webhooks')
    .set(paused === 'revoke' ? { revoked_at: clock.now(), paused: true } : { paused })
    .where('id', '=', id)
    .execute();
  if (paused === 'revoke')
    await db
      .updateTable('webhook_deliveries')
      .set({
        state: 'cancelled',
        completed_at: clock.now(),
        last_error: 'revoked',
        lease_token: null,
        lease_until: null,
      })
      .where('webhook_id', '=', id)
      .where('state', 'in', ['pending', 'sending'])
      .execute();
  await audit(
    db,
    clock,
    context,
    id,
    paused === 'revoke' ? 'revoked' : paused ? 'paused' : 'resumed',
  );
};

const queue = async (
  db: ChatDb,
  webhookIds: readonly string[],
  payload: WebhookPayload,
  now: Date,
  actorId: string | null,
): Promise<void> => {
  if (webhookIds.length === 0) return;
  await db
    .insertInto('webhook_deliveries')
    .values(
      webhookIds.map((webhookId) => ({
        id: messageId(now),
        webhook_id: webhookId,
        message_id: payload.data.messageId,
        actor_id: actorId,
        event_id: payload.id,
        event_type: payload.type,
        payload: JSON.stringify(payload),
        created_at: now,
        next_attempt_at: now,
        expires_at: new Date(now.getTime() + 86_400_000),
      })),
    )
    .onConflict((conflict) => conflict.columns(['webhook_id', 'event_id']).doNothing())
    .execute();
};

/** Called inside the source transaction, never after commit. Integrations cannot form webhook loops. */
export const enqueueWebhookEvent = async (
  db: ChatDb,
  message: Message,
  type: WebhookEventType,
  now: Date,
): Promise<void> => {
  if (
    message.sender === null ||
    message.incomingWebhook !== undefined ||
    message.githubEvent !== null
  )
    return;
  const hooks = await db
    .selectFrom('outgoing_webhooks')
    .innerJoin('channels', 'channels.id', 'outgoing_webhooks.channel_id')
    .select(['outgoing_webhooks.id', 'outgoing_webhooks.workspace_id'])
    .where('outgoing_webhooks.channel_id', '=', message.channelId)
    .where('outgoing_webhooks.revoked_at', 'is', null)
    .where('channels.type', '!=', 'direct_message')
    .where('channels.deleted_at', 'is', null)
    .where((eb) => eb('outgoing_webhooks.events', '@>', eb.val([type])))
    .limit(OUTGOING_WEBHOOKS_MAX)
    .execute();
  const first = hooks[0];
  if (first === undefined) return;
  const payload: WebhookPayload = {
    id: crypto.randomUUID(),
    type,
    version: 1,
    occurredAt: now.toISOString(),
    workspaceId: first.workspace_id,
    channelId: message.channelId,
    data: {
      messageId: message.id,
      content: message.content,
      senderId: message.sender.id,
      parentId: message.parentId,
    },
  };
  await queue(
    db,
    hooks.map((hook) => hook.id),
    payload,
    now,
    message.sender.id,
  );
};

export const testOutgoingWebhook = async (
  db: ChatTx,
  clock: Clock,
  context: ChannelContext,
  id: string,
): Promise<void> => {
  await ownOutgoingWebhook(db, context, id);
  const now = clock.now();
  await queue(
    db,
    [id],
    {
      id: crypto.randomUUID(),
      type: 'webhook.test',
      version: 1,
      occurredAt: now.toISOString(),
      workspaceId: context.workspaceId,
      channelId: context.channelId,
      data: { messageId: null, content: 'Purlay webhook test', senderId: null, parentId: null },
    },
    now,
    context.userId,
  );
  await audit(db, clock, context, id, 'tested');
};

export const outgoingDeliveries = async (
  db: ChatDb,
  context: ChannelContext,
  id: string,
  before?: string,
): Promise<WebhookDeliveryPage> => {
  await ownOutgoingWebhook(db, context, id);
  let query = db
    .selectFrom('webhook_deliveries')
    .selectAll()
    .where('webhook_id', '=', id)
    .orderBy('id', 'desc')
    .limit(26);
  if (before !== undefined) query = query.where('id', '<', before);
  const rows = await query.execute();
  const data = rows.slice(0, 25).map((row) => ({
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    state: row.state,
    attemptCount: row.attempt_count,
    createdAt: new Date(row.created_at).toISOString(),
    nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
    lastStatus: row.last_status,
    lastError: row.last_error,
  }));
  // Database state is narrowed at the wire boundary, never cast from free text.
  const result = { data, nextCursor: rows.length > 25 ? (data.at(-1)?.id ?? null) : null };
  if (!Value.Check(WebhookDeliveryPage, result)) throw new Error('invalid stored webhook delivery');
  return result;
};

export const deliveryAttempts = async (
  db: ChatDb,
  context: ChannelContext,
  hookId: string,
  deliveryId: string,
): Promise<WebhookAttemptList> => {
  await ownOutgoingWebhook(db, context, hookId);
  const delivery = await db
    .selectFrom('webhook_deliveries')
    .select('id')
    .where('id', '=', deliveryId)
    .where('webhook_id', '=', hookId)
    .executeTakeFirst();
  if (delivery === undefined) throw missing();
  const rows = await db
    .selectFrom('webhook_delivery_attempts')
    .selectAll()
    .where('delivery_id', '=', deliveryId)
    .orderBy('attempted_at', 'desc')
    .limit(100)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    attemptedAt: new Date(row.attempted_at).toISOString(),
    durationMs: row.duration_ms,
    status: row.status,
    error: row.error,
  }));
};

export const retryOutgoingDelivery = async (
  db: ChatTx,
  clock: Clock,
  context: ChannelContext,
  hookId: string,
  deliveryId: string,
): Promise<void> => {
  const hook = await ownOutgoingWebhook(db, context, hookId);
  if (hook.paused) throw invalid('webhookId', 'Resume this webhook before retrying.');
  const now = clock.now();
  const row = await db
    .updateTable('webhook_deliveries')
    .set({
      state: 'pending',
      next_attempt_at: now,
      expires_at: new Date(now.getTime() + 86_400_000),
      completed_at: null,
      lease_token: null,
      lease_until: null,
    })
    .where('id', '=', deliveryId)
    .where('webhook_id', '=', hookId)
    .where('state', '=', 'failed')
    .returning('id')
    .executeTakeFirst();
  if (row === undefined) throw missing();
  await audit(db, clock, context, hookId, 'retried');
};
