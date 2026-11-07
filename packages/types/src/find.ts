/**
 * The workspace-wide find (D-283 §4, D-285): one words, asked of every source of every module that runs, answered as a group
 * for each source. There is no one ranked list, because a score does not compare across sources, and no cursor, because one
 * across several sources is a promise nobody keeps: a source's own screen (chat's `search`) is where a person pages.
 */
import { Type, type Static } from '@sinclair/typebox';
import { SEARCH_QUERY_MAX, SEARCH_QUERY_MIN } from './api';
import { FromClient, Timestamp, Uuid } from './models';

/** The most hits one source answers: the find is a place to start from, not a result list. */
export const FIND_HITS_MAX = 10;

/** `GET /api/workspaces/:workspaceId/find?q=&limit=` — the words, three characters or more, as search's are. */
export const FindQuery = FromClient({
  q: Type.String({
    minLength: SEARCH_QUERY_MIN,
    maxLength: SEARCH_QUERY_MAX,
    format: 'plain-text',
  }),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: FIND_HITS_MAX, default: FIND_HITS_MAX }),
  ),
});
export type FindQuery = Static<typeof FindQuery>;

/** Where a hit leads, by the ids a client opens it with. A client ignores a target it does not know, as any union member. */
export const FindTarget = Type.Union([
  Type.Object({ type: Type.Literal('message'), channelId: Uuid, messageId: Uuid }),
  Type.Object({ type: Type.Literal('issue'), issueId: Uuid }),
]);
export type FindTarget = Static<typeof FindTarget>;

/** One thing found: a line to show, a few words around the match where there are any, when it was made, and where it leads. */
export const FindHit = Type.Object({
  id: Uuid,
  title: Type.String({ maxLength: 200 }),
  excerpt: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  at: Timestamp,
  target: FindTarget,
});
export type FindHit = Static<typeof FindHit>;

/** What one source found, newest first. A source that found nothing is a group with no hits, which is not a skipped one. */
export const FindGroup = Type.Object({
  source: Type.String(),
  hits: Type.Array(FindHit, { maxItems: FIND_HITS_MAX }),
});
export type FindGroup = Static<typeof FindGroup>;

/**
 * A source that was not asked or did not answer: its module is `off` here, it was `slow` past its deadline, or it failed
 * (`error`). The others' groups are answered all the same.
 */
export const SkippedSource = Type.Object({
  source: Type.String(),
  reason: Type.Union([Type.Literal('off'), Type.Literal('slow'), Type.Literal('error')]),
});
export type SkippedSource = Static<typeof SkippedSource>;

export const FindResponse = Type.Object({
  groups: Type.Array(FindGroup),
  skipped: Type.Array(SkippedSource),
});
export type FindResponse = Static<typeof FindResponse>;
