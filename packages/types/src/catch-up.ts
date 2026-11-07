/** Private catch-up pages: roots are read explicitly, replies in their own threads (D-282). */
import { Type, type Static } from '@sinclair/typebox';
import { FromClient, Message, Uuid } from './models';
import { MessagePage, PAGE_LIMIT } from './api';

export const CATCH_UP_PAGE = 20;

export const CatchUpQuery = FromClient({
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: PAGE_LIMIT.max, default: CATCH_UP_PAGE }),
  ),
  /** Waiting thread roots after this UUID; roots remain bounded by the caller's stored feed position. */
  afterThread: Type.Optional(Uuid),
});
export type CatchUpQuery = Static<typeof CatchUpQuery>;

export const UnreadThread = Type.Object({
  root: Message,
  firstUnreadMessageId: Uuid,
  unreadCount: Type.Integer({ minimum: 1 }),
});
export type UnreadThread = Static<typeof UnreadThread>;

export const ChannelCatchUp = Type.Object({
  roots: MessagePage,
  threads: Type.Array(UnreadThread, { maxItems: PAGE_LIMIT.max }),
  nextThreadCursor: Type.Union([Uuid, Type.Null()]),
});
export type ChannelCatchUp = Static<typeof ChannelCatchUp>;
