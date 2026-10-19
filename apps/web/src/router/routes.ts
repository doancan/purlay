/**
 * The routes, and the only place an address is spelled (D-98).
 *
 * A route is a name and a path pattern; everything else — which address a link
 * points at, which screen an address means, what a screen's params are called —
 * is derived from this table, so a path written twice cannot disagree with
 * itself. The params' names are read out of the pattern by the type system:
 * `href('channel', { slug, channelId })` compiles, and leaving `channelId` out or
 * misspelling it does not.
 *
 * This is the part of a router that is a lookup. It is deliberately not a
 * library: the client has a handful of routes, and 15–25 KB of the 250 KB budget
 * is a poor price for matching a path and calling `history.pushState`.
 */
import { SIGN_IN_PATH } from '@purlay/types';

const ROUTES = {
  // The API sends a failed sign-in back here, so the contract spells it (D-121).
  signIn: SIGN_IN_PATH,
  // A sign-in link's page; its token is in the fragment, never the path (D-138 §4).
  signInEmail: `${SIGN_IN_PATH}/email`,
  invite: '/invite',
  home: '/',
  workspace: '/w/:slug',
  channel: '/w/:slug/c/:channelId',
  questions: '/w/:slug/questions',
  inbox: '/w/:slug/inbox',
  search: '/w/:slug/search',
  saved: '/w/:slug/saved',
  welcome: '/w/:slug/welcome',
  // Settings are a page with a navigation of its own (D-146); the bare address opens Profile.
  settingsHome: '/w/:slug/settings',
  settings: '/w/:slug/settings/:section',
  gallery: '/__gallery',
} as const;

export type RouteName = keyof typeof ROUTES;

type ParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<Rest>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

export type RouteParams<N extends RouteName> = Readonly<
  Record<ParamNames<(typeof ROUTES)[N]>, string>
>;

/** What an address means: a route and its params, or nothing this client serves. */
export type Match =
  | { readonly [N in RouteName]: { readonly name: N; readonly params: RouteParams<N> } }[RouteName]
  | { readonly name: 'notFound'; readonly params: Readonly<Record<string, never>> };

type Arguments<N extends RouteName> = keyof RouteParams<N> extends never
  ? []
  : [params: RouteParams<N>];

/**
 * The parts of a path. Only the ends are trimmed: an empty segment in the middle
 * (`/w//questions`) must stay empty, or it would quietly become a different route
 * (`/w/questions`, a workspace called "questions").
 */
const segments = (path: string): readonly string[] => {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? [] : trimmed.split('/');
};

const tryDecode = (part: string): string | null => {
  try {
    return decodeURIComponent(part);
  } catch {
    // `%E0%A4%A` is not text; an address that is not text is not a route.
    return null;
  }
};

/** Matches one pattern against one pathname, or null. Trailing slashes do not matter. */
const matchPattern = (pattern: string, pathname: string): Record<string, string> | null => {
  const want = segments(pattern);
  const have = segments(pathname);
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (const [index, part] of want.entries()) {
    const actual = have[index] ?? '';
    if (part.startsWith(':')) {
      const decoded = tryDecode(actual);
      if (decoded === null || decoded === '') return null;
      params[part.slice(1)] = decoded;
    } else if (part !== actual) {
      return null;
    }
  }
  return params;
};

export const matchRoute = (pathname: string): Match => {
  for (const name of Object.keys(ROUTES) as RouteName[]) {
    const params = matchPattern(ROUTES[name], pathname);
    // The table is the type's source, so the cast is the one place a plain record
    // becomes the precise params a pattern promises — `matchPattern` just checked it.
    if (params !== null) return { name, params } as Match;
  }
  return { name: 'notFound', params: {} };
};

/** The address of a route, from untyped params; `href` is the typed way in. */
export const spell = (name: RouteName, params: Readonly<Record<string, string>> = {}): string =>
  ROUTES[name].replace(/:(\w+)/g, (_, key: string) => encodeURIComponent(params[key] ?? ''));

export const href = <N extends RouteName>(name: N, ...args: Arguments<N>): string =>
  spell(name, args[0]);

/**
 * `?thread=<message id>` on a channel's address: open this root's thread when the channel
 * opens (the open-questions view links to a question this way). The query parameters the
 * client defines are spelled and read here, beside the routes.
 */
const THREAD_PARAM = 'thread';

export const threadHref = (slug: string, channelId: string, messageId: string): string =>
  `${href('channel', { slug, channelId })}?${THREAD_PARAM}=${encodeURIComponent(messageId)}`;

/** The thread an address asks to open, or null; anything that is not an id-shaped value is not asked for. */
export const threadInSearch = (search: string): string | null => {
  const value = new URLSearchParams(search).get(THREAD_PARAM);
  return value !== null && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
};

/**
 * `?message=<message id>` on a channel's address: a link to one message (D-149). The channel opens
 * around it, scrolled to it and marked for a moment; a reply opens its thread and is marked there.
 * What "Copy link" puts on the clipboard, and where search, saved items and pins go.
 */
const MESSAGE_PARAM = 'message';

/** An id as the server spells one: anything else in an address is not asked for. */
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const messageHref = (slug: string, channelId: string, messageId: string): string =>
  `${href('channel', { slug, channelId })}?${MESSAGE_PARAM}=${encodeURIComponent(messageId)}`;

/** The message an address links to, or null; anything that is not an id is not a link. */
export const messageInSearch = (search: string): string | null => {
  const value = new URLSearchParams(search).get(MESSAGE_PARAM);
  return value !== null && ID_SHAPE.test(value) ? value : null;
};

/**
 * `?q=` on the search screen's address: the words searched for, so Back, a reload and a shared
 * link all come back to the same results.
 */
const WORDS_PARAM = 'q';

/** The channel a search is narrowed to (`PRD.md` §4.6), beside the words. */
const CHANNEL_PARAM = 'in';

export const searchHref = (
  slug: string,
  words: string,
  channelId: string | null = null,
): string => {
  const params = new URLSearchParams();
  if (words !== '') params.set(WORDS_PARAM, words);
  if (channelId !== null) params.set(CHANNEL_PARAM, channelId);
  const query = params.toString();
  return query === '' ? href('search', { slug }) : `${href('search', { slug })}?${query}`;
};

/**
 * The query that narrows a list to one channel: a search (`PRD.md` §4.6), or the open questions,
 * which a channel's header opens narrowed to the channel it counts (`UX.md` §2).
 */
export const narrowedTo = (channelId: string): string =>
  new URLSearchParams({ [CHANNEL_PARAM]: channelId }).toString();

/** The words an address searches for, trimmed; empty when it asks for none. */
export const wordsInSearch = (search: string): string =>
  (new URLSearchParams(search).get(WORDS_PARAM) ?? '').trim();

/** The channel an address narrows a list to; null for every channel, or for anything not an id. */
export const channelInSearch = (search: string): string | null => {
  const named = new URLSearchParams(search).get(CHANNEL_PARAM);
  return named !== null && ID_SHAPE.test(named) ? named : null;
};
