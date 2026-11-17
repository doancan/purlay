/** Thin HTTP adapters for channel webhooks (D-312). */
import { Elysia, type AnyElysia } from 'elysia';
import {
  OutgoingWebhookRequest,
  OutgoingWebhookUpdate,
  WebhookDeliveryQuery,
  Uuid,
} from '@purlay/types';
import type { ChatRouteDependencies } from './dependencies';
import { requireSession } from '../../../ingress/http/session';
import { queryOf, validated } from '../../../ingress/http/validate';
import { atomicallyOn } from '../../../platform/transactions';
import { requireChannelById, type ChannelContext } from '../channels/guard';
import type { ChatTx } from '../schema';
import {
  changeOutgoingWebhook,
  createOutgoingWebhook,
  deliveryAttempts,
  listOutgoingWebhooks,
  outgoingDeliveries,
  retryOutgoingDelivery,
  rotateOutgoingWebhook,
  testOutgoingWebhook,
} from '../integrations/outgoing-webhooks';
import { rotateIncomingWebhook } from '../integrations/incoming-webhooks';

const inChannel = async <T>(
  dependencies: ChatRouteDependencies,
  request: Request,
  channelId: string,
  work: (db: ChatTx, context: ChannelContext) => Promise<T>,
): Promise<T> => {
  const { userId } = await requireSession(dependencies.auth, request);
  return await atomicallyOn(dependencies.database)(async (db) => {
    const context = await requireChannelById(db, userId, channelId);
    return await work(db, context);
  });
};

export const outgoingWebhookRoutes = (context: ChatRouteDependencies): AnyElysia =>
  new Elysia()
    .post(
      '/api/channels/:channelId/incoming-webhooks/:webhookId/secret',
      async ({ request, params }) =>
        await inChannel(
          context,
          request,
          params.channelId,
          async (db, channel) =>
            await rotateIncomingWebhook(
              db,
              context.clock,
              channel,
              validated(Uuid, params.webhookId),
            ),
        ),
    )
    .get(
      '/api/channels/:channelId/outgoing-webhooks',
      async ({ request, params }) =>
        await inChannel(
          context,
          request,
          params.channelId,
          async (db, channel) => await listOutgoingWebhooks(db, channel),
        ),
    )
    .post('/api/channels/:channelId/outgoing-webhooks', async ({ request, params, body, set }) => {
      const answer = await inChannel(
        context,
        request,
        params.channelId,
        async (db, channel) =>
          await createOutgoingWebhook(
            db,
            context.clock,
            context.cipher,
            channel,
            validated(OutgoingWebhookRequest, body),
          ),
      );
      set.status = 201;
      return answer;
    })
    .patch(
      '/api/channels/:channelId/outgoing-webhooks/:outgoingWebhookId',
      async ({ request, params, body, set }) => {
        await inChannel(context, request, params.channelId, async (db, channel) => {
          await changeOutgoingWebhook(
            db,
            context.clock,
            channel,
            validated(Uuid, params.outgoingWebhookId),
            validated(OutgoingWebhookUpdate, body).paused,
          );
        });
        set.status = 204;
        return null;
      },
    )
    .delete(
      '/api/channels/:channelId/outgoing-webhooks/:outgoingWebhookId',
      async ({ request, params, set }) => {
        await inChannel(context, request, params.channelId, async (db, channel) => {
          await changeOutgoingWebhook(
            db,
            context.clock,
            channel,
            validated(Uuid, params.outgoingWebhookId),
            'revoke',
          );
        });
        set.status = 204;
        return null;
      },
    )
    .post(
      '/api/channels/:channelId/outgoing-webhooks/:outgoingWebhookId/secret',
      async ({ request, params }) =>
        await inChannel(
          context,
          request,
          params.channelId,
          async (db, channel) =>
            await rotateOutgoingWebhook(
              db,
              context.clock,
              context.cipher,
              channel,
              validated(Uuid, params.outgoingWebhookId),
            ),
        ),
    )
    .post(
      '/api/channels/:channelId/outgoing-webhooks/:outgoingWebhookId/test',
      async ({ request, params, set }) => {
        await inChannel(context, request, params.channelId, async (db, channel) => {
          await testOutgoingWebhook(
            db,
            context.clock,
            channel,
            validated(Uuid, params.outgoingWebhookId),
          );
        });
        set.status = 204;
        return null;
      },
    )
    .get(
      '/api/channels/:channelId/outgoing-webhooks/:outgoingWebhookId/deliveries',
      async ({ request, params }) => {
        const query = validated(WebhookDeliveryQuery, queryOf(new URL(request.url)));
        return await inChannel(
          context,
          request,
          params.channelId,
          async (db, channel) =>
            await outgoingDeliveries(
              db,
              channel,
              validated(Uuid, params.outgoingWebhookId),
              query.before,
            ),
        );
      },
    )
    .get(
      '/api/channels/:channelId/outgoing-webhooks/:outgoingWebhookId/deliveries/:deliveryId/attempts',
      async ({ request, params }) =>
        await inChannel(
          context,
          request,
          params.channelId,
          async (db, channel) =>
            await deliveryAttempts(
              db,
              channel,
              validated(Uuid, params.outgoingWebhookId),
              validated(Uuid, params.deliveryId),
            ),
        ),
    )
    .post(
      '/api/channels/:channelId/outgoing-webhooks/:outgoingWebhookId/deliveries/:deliveryId/retry',
      async ({ request, params, set }) => {
        await inChannel(context, request, params.channelId, async (db, channel) => {
          await retryOutgoingDelivery(
            db,
            context.clock,
            channel,
            validated(Uuid, params.outgoingWebhookId),
            validated(Uuid, params.deliveryId),
          );
        });
        set.status = 204;
        return null;
      },
    );
