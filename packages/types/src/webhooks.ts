/** Channel webhook contracts (D-312). */
import { Type, type Static } from '@sinclair/typebox';
import { FromClient, IncomingWebhookName, Timestamp, Uuid } from './models';

export const OUTGOING_WEBHOOKS_MAX = 10;
export const WebhookEventType = Type.Union([
  Type.Literal('message.created'),
  Type.Literal('thread.resolved'),
  Type.Literal('thread.reopened'),
]);
export type WebhookEventType = Static<typeof WebhookEventType>;
export const OutgoingWebhookRequest = FromClient({
  name: IncomingWebhookName,
  url: Type.String({ minLength: 1, maxLength: 2048, format: 'uri' }),
  events: Type.Array(WebhookEventType, { minItems: 1, maxItems: 3, uniqueItems: true }),
});
export type OutgoingWebhookRequest = Static<typeof OutgoingWebhookRequest>;
export const OutgoingWebhookUpdate = FromClient({ paused: Type.Boolean() });
export const OutgoingWebhook = Type.Object({
  id: Uuid,
  channelId: Uuid,
  name: Type.String(),
  url: Type.String(),
  events: Type.Array(WebhookEventType),
  paused: Type.Boolean(),
  createdAt: Timestamp,
});
export type OutgoingWebhook = Static<typeof OutgoingWebhook>;
export const OutgoingWebhookList = Type.Array(OutgoingWebhook, { maxItems: OUTGOING_WEBHOOKS_MAX });
export type OutgoingWebhookList = Static<typeof OutgoingWebhookList>;
export const CreatedOutgoingWebhook = Type.Object({
  webhook: OutgoingWebhook,
  secret: Type.String(),
});
export type CreatedOutgoingWebhook = Static<typeof CreatedOutgoingWebhook>;
export const WebhookPayload = Type.Object({
  id: Uuid,
  type: Type.Union([WebhookEventType, Type.Literal('webhook.test')]),
  version: Type.Literal(1),
  occurredAt: Timestamp,
  workspaceId: Uuid,
  channelId: Uuid,
  data: Type.Object({
    messageId: Type.Union([Uuid, Type.Null()]),
    content: Type.String(),
    senderId: Type.Union([Uuid, Type.Null()]),
    parentId: Type.Union([Uuid, Type.Null()]),
  }),
});
export type WebhookPayload = Static<typeof WebhookPayload>;
export const WebhookDeliveryQuery = FromClient({ before: Type.Optional(Uuid) });
export const WebhookAttempt = Type.Object({
  id: Uuid,
  attemptedAt: Timestamp,
  durationMs: Type.Integer(),
  status: Type.Union([Type.Integer(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
});
export const WebhookDelivery = Type.Object({
  id: Uuid,
  eventId: Uuid,
  eventType: Type.String(),
  state: Type.Union([
    Type.Literal('pending'),
    Type.Literal('sending'),
    Type.Literal('succeeded'),
    Type.Literal('failed'),
    Type.Literal('cancelled'),
  ]),
  attemptCount: Type.Integer(),
  createdAt: Timestamp,
  nextAttemptAt: Timestamp,
  lastStatus: Type.Union([Type.Integer(), Type.Null()]),
  lastError: Type.Union([Type.String(), Type.Null()]),
});
export type WebhookDelivery = Static<typeof WebhookDelivery>;
export const WebhookDeliveryPage = Type.Object({
  data: Type.Array(WebhookDelivery),
  nextCursor: Type.Union([Uuid, Type.Null()]),
});
export type WebhookDeliveryPage = Static<typeof WebhookDeliveryPage>;
export const WebhookAttemptList = Type.Array(WebhookAttempt);
export type WebhookAttemptList = Static<typeof WebhookAttemptList>;
