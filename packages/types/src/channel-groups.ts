/** Personal channel headings and placement, scoped to one person and workspace (#1198). */
import { Type, type Static } from '@sinclair/typebox';
import { PAGE_LIMIT } from './api';
import { FromClient, Uuid } from './models';

export const CHANNEL_GROUP_LIMIT = 20;
export const CHANNEL_GROUP_NAME_MAX = 64;

const Name = Type.String({ minLength: 1, maxLength: CHANNEL_GROUP_NAME_MAX, format: 'name' });

export const ChannelGroup = Type.Object({ id: Uuid, name: Name, collapsed: Type.Boolean() });
export type ChannelGroup = Static<typeof ChannelGroup>;

export const ChannelGroupPage = Type.Object({
  data: Type.Array(ChannelGroup, { maxItems: Math.min(CHANNEL_GROUP_LIMIT, PAGE_LIMIT.max) }),
  nextCursor: Type.Union([Uuid, Type.Null()]),
});
export type ChannelGroupPage = Static<typeof ChannelGroupPage>;

export const ChannelGroupQuery = FromClient({
  before: Type.Optional(Uuid),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: PAGE_LIMIT.max, default: PAGE_LIMIT.default }),
  ),
});
export type ChannelGroupQuery = Static<typeof ChannelGroupQuery>;

/** A client-generated id in the path makes creating the same group repeatable. */
export const SaveChannelGroupRequest = FromClient({ name: Name });
export type SaveChannelGroupRequest = Static<typeof SaveChannelGroupRequest>;

export const FoldChannelGroupRequest = FromClient({ collapsed: Type.Boolean() });
export type FoldChannelGroupRequest = Static<typeof FoldChannelGroupRequest>;

export const MoveChannelGroupRequest = FromClient({ groupId: Type.Union([Uuid, Type.Null()]) });
export type MoveChannelGroupRequest = Static<typeof MoveChannelGroupRequest>;
