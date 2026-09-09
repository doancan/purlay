/**
 * The message endpoints Phase 0 serves (`API.md` §5).
 *
 * `POST` here is the **fallback when the socket is down**, running the same
 * service as the `MESSAGE_SEND` frame — the socket is an optimisation, never the
 * only path (`ARCHITECTURE.md` §5.1). One service, two entry points, so the two
 * cannot validate differently.
 */
import type { Executor } from '@purlay/db';
import { PageQuery, SendMessageRequest, type Message, type MessagePage } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { requireChannelById } from '../../platform/channels';
import { messageHistory, sendMessage } from '../../modules/messages/messages';
import { requireSession } from './session';
import { validated } from './validate';

export interface MessageDependencies {
  readonly database: Executor;
  readonly clock: Clock;
}

/**
 * Query strings arrive as text. The contract's types are `integer` and `uuid`, so
 * `limit` is converted before validation rather than after — a string `"50"`
 * would otherwise be refused by the very schema that documents the default.
 */
const asPageQuery = (url: URL): unknown => {
  const query: Record<string, unknown> = {};
  for (const key of ['before', 'after'] as const) {
    const value = url.searchParams.get(key);
    if (value !== null) query[key] = value;
  }
  const limit = url.searchParams.get('limit');
  if (limit !== null) query['limit'] = Number(limit);
  return query;
};

export const readHistory = async (
  dependencies: MessageDependencies,
  request: Request,
  channelId: string,
): Promise<MessagePage> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireChannelById(database, userId, channelId);
  const query = validated(PageQuery, asPageQuery(new URL(request.url)));
  return await messageHistory(database, context, query);
};

export const postMessage = async (
  dependencies: MessageDependencies,
  request: Request,
  channelId: string,
  body: unknown,
): Promise<Message> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireChannelById(database, userId, channelId);
  const input = validated(SendMessageRequest, body);
  return await sendMessage(database, clock, context, input);
};
