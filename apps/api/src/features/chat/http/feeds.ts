/**
 * A channel's repository feeds through HTTP (#79, D-134): list, connect, regenerate the secret of, and disconnect, each an
 * owner's or an admin's in a channel they can see. Validate, call one service, answer.
 */
import { Elysia, type AnyElysia } from 'elysia';
import type { ChatRouteDependencies } from './dependencies';
import {
  CreateGitHubFeedRequest,
  type CreatedGitHubFeed,
  type GitHubFeedList,
} from '@purlay/types';
import { requireChannelById } from '../channels/guard';
import type { CredentialCipher } from '../../../platform/crypto';
import { atomicallyOn } from '../../../platform/transactions';
import { channelFeeds, createFeed, regenerateSecret, removeFeed } from '../integrations/feeds';
import type { ChannelDependencies } from './channels';
import { requireSession } from '../../../ingress/http/session';
import { validated } from '../../../ingress/http/validate';

type FeedDependencies = ChannelDependencies & { readonly cipher: CredentialCipher };

/** `GET /api/channels/:channelId/github-feeds` */
const listFeeds = async (
  { auth, database }: ChannelDependencies,
  request: Request,
  channelId: string,
): Promise<GitHubFeedList> => {
  const { userId } = await requireSession(auth, request);
  const context = await requireChannelById(database, userId, channelId);
  return await channelFeeds(database, context);
};

/** `POST /api/channels/:channelId/github-feeds` — the feed, its address and its secret, once. */
const connectFeed = async (
  { auth, database, clock, cipher }: FeedDependencies,
  request: Request,
  channelId: string,
  body: unknown,
): Promise<CreatedGitHubFeed> => {
  const { userId } = await requireSession(auth, request);
  const asked = validated(CreateGitHubFeedRequest, body);
  return await atomicallyOn(database)(async (transaction) => {
    const context = await requireChannelById(transaction, userId, channelId);
    return await createFeed(transaction, clock, cipher, context, asked);
  });
};

/** `POST /api/channels/:channelId/github-feeds/:feedId/secret` — the new secret, once. */
const regenerateFeedSecret = async (
  { auth, database, clock, cipher }: FeedDependencies,
  request: Request,
  channelId: string,
  feedId: string,
): Promise<CreatedGitHubFeed> => {
  const { userId } = await requireSession(auth, request);
  return await atomicallyOn(database)(async (transaction) => {
    const context = await requireChannelById(transaction, userId, channelId);
    return await regenerateSecret(transaction, clock, cipher, context, feedId);
  });
};

/** `DELETE /api/channels/:channelId/github-feeds/:feedId` */
const disconnectFeed = async (
  { auth, database, clock }: ChannelDependencies,
  request: Request,
  channelId: string,
  feedId: string,
): Promise<void> => {
  const { userId } = await requireSession(auth, request);
  await atomicallyOn(database)(async (transaction) => {
    const context = await requireChannelById(transaction, userId, channelId);
    await removeFeed(transaction, clock, context, feedId);
  });
};

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const feedRoutes = (context: ChatRouteDependencies): AnyElysia =>
  new Elysia()
    .get(
      '/api/channels/:channelId/github-feeds',
      async ({ request, params }) => await listFeeds(context, request, params.channelId),
    )
    .post('/api/channels/:channelId/github-feeds', async ({ request, params, body, set }) => {
      const created = await connectFeed(context, request, params.channelId, body);
      set.status = 201;
      return created;
    })
    .post(
      '/api/channels/:channelId/github-feeds/:feedId/secret',
      async ({ request, params }) =>
        await regenerateFeedSecret(context, request, params.channelId, params.feedId),
    )
    .delete('/api/channels/:channelId/github-feeds/:feedId', async ({ request, params, set }) => {
      await disconnectFeed(context, request, params.channelId, params.feedId);
      set.status = 204;
      return null;
    });
