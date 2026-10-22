/**
 * A channel's repository feeds through HTTP (#79, D-134): list, connect and disconnect, each an
 * owner's or an admin's in a channel they can see. Validate, call one service, answer.
 */
import {
  CreateGitHubFeedRequest,
  type CreatedGitHubFeed,
  type GitHubFeedList,
} from '@purlay/types';
import { requireChannelById } from '../../platform/channels';
import type { CredentialCipher } from '../../platform/crypto';
import { atomicallyOn } from '../../platform/transactions';
import { channelFeeds, createFeed, removeFeed } from '../../modules/integrations/feeds';
import type { ChannelDependencies } from './channels';
import { requireSession } from './session';
import { validated } from './validate';

type FeedDependencies = ChannelDependencies & { readonly cipher: CredentialCipher };

/** `GET /api/channels/:channelId/github-feeds` */
export const listFeeds = async (
  { auth, database }: ChannelDependencies,
  request: Request,
  channelId: string,
): Promise<GitHubFeedList> => {
  const { userId } = await requireSession(auth, request);
  const context = await requireChannelById(database, userId, channelId);
  return await channelFeeds(database, context);
};

/** `POST /api/channels/:channelId/github-feeds` — the feed, its address and its secret, once. */
export const connectFeed = async (
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

/** `DELETE /api/channels/:channelId/github-feeds/:feedId` */
export const disconnectFeed = async (
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
