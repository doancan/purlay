/** A rendered web link in a conversation's Shared catalogue (#1406), distinct from public preview candidates. */
import { Type, type Static } from '@sinclair/typebox';
import {
  Attachment,
  FromClient,
  IncomingWebhookName,
  MESSAGE_CONTENT_MAX,
  Timestamp,
  User,
  Uuid,
} from './models';
import { PAGE_LIMIT } from './api';

// URL normalization can percent-encode a three-byte BMP character into nine ASCII characters.
// This preserves links from a valid source body without imposing the preview service's smaller cap.
export const SHARED_LINK_URL_MAX = MESSAGE_CONTENT_MAX * 9 + 16;

export const SharedLink = Type.Object({
  url: Type.String({ format: 'uri', pattern: '^https?://', maxLength: SHARED_LINK_URL_MAX }),
  label: Type.String({ minLength: 1, maxLength: MESSAGE_CONTENT_MAX }),
});
export type SharedLink = Static<typeof SharedLink>;

export const SharedFileType = Type.Union(
  (['image', 'pdf', 'video', 'audio', 'other'] as const).map((kind) => Type.Literal(kind)),
);
export type SharedFileType = Static<typeof SharedFileType>;

/** The source is always a currently readable message, including a named incoming integration. */
const origin = {
  messageId: Uuid,
  parentId: Type.Union([Uuid, Type.Null()]),
  channelId: Uuid,
  sender: Type.Union([User, Type.Null()]),
  sourceName: Type.Union([IncomingWebhookName, Type.Null()]),
  sentAt: Timestamp,
};
export const SharedFileItem = Type.Object({
  ...origin,
  kind: Type.Literal('file'),
  attachment: Attachment,
});
export type SharedFileItem = Static<typeof SharedFileItem>;
export type SharedOrigin = Omit<SharedFileItem, 'kind' | 'attachment'>;
export const SharedLinkItem = Type.Object({
  ...origin,
  kind: Type.Literal('link'),
  key: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  link: SharedLink,
});
export type SharedLinkItem = Static<typeof SharedLinkItem>;
export const SharedItem = Type.Union([SharedFileItem, SharedLinkItem]);
export type SharedItem = Static<typeof SharedItem>;

export const SharedQuery = FromClient({
  view: Type.Union([Type.Literal('files'), Type.Literal('links')]),
  q: Type.Optional(Type.String({ maxLength: 256, format: 'plain-text' })),
  channelId: Type.Optional(Uuid),
  senderId: Type.Optional(Uuid),
  type: Type.Optional(SharedFileType),
  since: Type.Optional(Timestamp),
  until: Type.Optional(Timestamp),
  before: Type.Optional(Type.String({ minLength: 1, maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: PAGE_LIMIT.max, default: PAGE_LIMIT.default }),
  ),
});
export type SharedQuery = Static<typeof SharedQuery>;
export const SharedFilters = Type.Omit(SharedQuery, ['before', 'limit']);
export type SharedFilters = Static<typeof SharedFilters>;
/** Compound opaque keyset cursor; it is deliberately not the UUID-only Page helper. */
export const SharedPage = Type.Object({
  data: Type.Array(SharedItem, { maxItems: PAGE_LIMIT.max }),
  nextCursor: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
  indexing: Type.Boolean(),
});
export type SharedPage = Static<typeof SharedPage>;
