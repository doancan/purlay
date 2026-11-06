/**
 * A channel's incoming webhooks through HTTP (D-245): list, make and revoke, each an owner's or an
 * admin's in a channel they can see; and the post a tool makes to a hook's address, with no session.
 * Validate, call one service, answer.
 */
import { Elysia, type AnyElysia } from 'elysia';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import type { GitHubWiring } from './wiring';
import { limitKeyFor } from '../../../platform/client-key';
import { clientAddress, peerOf } from '../../../ingress/http/client-address';
import {
  CreateIncomingWebhookRequest,
  IncomingWebhookPost,
  type CreatedIncomingWebhook,
  type IncomingWebhookAnswer,
  type IncomingWebhookList,
} from '@purlay/types';
import { requireChannelById } from '../channels/guard';
import { AppError } from '../../../platform/errors';
import { atomicallyOn } from '../../../platform/transactions';
import {
  channelWebhooks,
  createWebhook,
  receivePost,
  revokeWebhook,
  type IncomingPostDependencies,
} from '../integrations/incoming-webhooks';
import type { ChannelDependencies } from './channels';
import { requireSession } from '../../../ingress/http/session';
import { validated } from '../../../ingress/http/validate';

/** `GET /api/channels/:channelId/incoming-webhooks` */
const listIncomingWebhooks = async (
  { auth, database }: ChannelDependencies,
  request: Request,
  channelId: string,
): Promise<IncomingWebhookList> => {
  const { userId } = await requireSession(auth, request);
  const context = await requireChannelById(database, userId, channelId);
  return await channelWebhooks(database, context);
};

/** `POST /api/channels/:channelId/incoming-webhooks` — the hook, and its address with its secret, once. */
const makeIncomingWebhook = async (
  { auth, database, clock }: ChannelDependencies,
  request: Request,
  channelId: string,
  body: unknown,
): Promise<CreatedIncomingWebhook> => {
  const { userId } = await requireSession(auth, request);
  const asked = validated(CreateIncomingWebhookRequest, body);
  return await atomicallyOn(database)(async (transaction) => {
    const context = await requireChannelById(transaction, userId, channelId);
    return await createWebhook(transaction, clock, context, asked);
  });
};

/** `DELETE /api/channels/:channelId/incoming-webhooks/:webhookId` */
const revokeIncomingWebhook = async (
  { auth, database, clock }: ChannelDependencies,
  request: Request,
  channelId: string,
  webhookId: string,
): Promise<void> => {
  const { userId } = await requireSession(auth, request);
  await atomicallyOn(database)(async (transaction) => {
    const context = await requireChannelById(transaction, userId, channelId);
    await revokeWebhook(transaction, clock, context, webhookId);
  });
};

export interface IncomingPostRouteDependencies extends IncomingPostDependencies {
  /** Whether this address may knock once more: its own bucket, before anything is looked up. */
  readonly mayKnock: (address: string) => Promise<boolean>;
}

/**
 * `POST /api/webhooks/incoming/:webhookId/:secret` — nobody is signed in, so the edge has held the body to
 * the JSON bound, and the address spends its own bucket before a hook is looked up (D-245).
 */
export const postIncomingWebhook = async (
  dependencies: IncomingPostRouteDependencies,
  params: { readonly webhookId: string; readonly secret: string },
  body: unknown,
  address: string,
): Promise<IncomingWebhookAnswer> => {
  if (!(await dependencies.mayKnock(address))) {
    dependencies.log.warn('incoming webhook', { outcome: 'knocked_too_often' });
    throw new AppError({ code: 'RATE_LIMITED', message: 'Too many posts. Slow down.' });
  }
  const { text } = validated(IncomingWebhookPost, body);
  const messageId = await receivePost(dependencies, { ...params, text });
  return { messageId };
};

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const incomingWebhookRoutes = (
  context: ModuleRouteDependencies,
  wiring: GitHubWiring,
): AnyElysia =>
  new Elysia()
    .get(
      '/api/channels/:channelId/incoming-webhooks',
      async ({ request, params }) => await listIncomingWebhooks(context, request, params.channelId),
    )
    .post('/api/channels/:channelId/incoming-webhooks', async ({ request, params, body, set }) => {
      const created = await makeIncomingWebhook(context, request, params.channelId, body);
      set.status = 201;
      return created;
    })
    .delete(
      '/api/channels/:channelId/incoming-webhooks/:webhookId',
      async ({ request, params, set }) => {
        await revokeIncomingWebhook(context, request, params.channelId, params.webhookId);
        set.status = 204;
        return null;
      },
    )
    .post(
      '/api/webhooks/incoming/:webhookId/:secret',
      async ({ request, params, body, set, server }) => {
        const answer = await postIncomingWebhook(
          {
            database: context.database,
            clock: context.clock,
            bus: context.bus,
            log: context.log,
            mayPost: async (webhookId) => await wiring.hookPosts.consume(webhookId),
            mayKnock: async (address) => await wiring.knocks.consume(address),
          },
          params,
          body,
          limitKeyFor(
            clientAddress(peerOf(server, request), request.headers, context.config.TRUST_PROXY),
          ),
        );
        set.status = 201;
        return answer;
      },
    );
