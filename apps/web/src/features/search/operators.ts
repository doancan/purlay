/**
 * Search operators (D-224): `in:#api from:@alice has:code deploy`, typed where the words are, read
 * into the filters search already has — never a second way of filtering. What the server is asked,
 * what the address keeps and what a saved search stores stay the structured criteria; the operators
 * are a way of typing them, and are taken out of the words when they are read.
 *
 * - **What is an operator**: a known key (case ignored, `İ`/`I`/`ı` as `i`), a colon and a value, as
 *   one token. Anything else is words — `foo:bar`, a link, `10:30` — and nothing typed vanishes.
 * - **Quotes keep words words**: `"is:open"` is searched for as written; a phrase is the words between
 *   two quotes, without them. A quote with no partner is a character like any other.
 * - **An operator that cannot be read** — a channel or a person nobody here is called, a value the
 *   filter does not take, an empty one (`from:`) — is left in the words, where it is searched for as
 *   typed, and `unreadOperators` says why, so it is never silently dropped.
 * - **The last one wins**, as the controls do: `is:open is:resolved` asks for resolved.
 *
 * Pure: the channels, the people and the time zone's day are the caller's (`Directory`).
 */
import { Value } from '@sinclair/typebox/value';
import {
  SEARCH_QUERY_MAX,
  SEARCH_QUERY_MIN,
  SearchFilters,
  type Channel,
  type WorkspaceMember,
} from '@purlay/types';
import { fold } from '../composer/mention-suggest';

const OPERATOR_KEYS = ['in', 'from', 'has', 'is', 'repo', 'before', 'after', 'on'] as const;
type OperatorKey = (typeof OPERATOR_KEYS)[number];

export type SearchPart =
  | { readonly kind: 'words'; readonly text: string }
  | {
      readonly kind: 'operator';
      readonly key: OperatorKey;
      readonly value: string;
      /** As it was typed, which is what goes back into the words when it cannot be read. */
      readonly token: string;
    };

/** A key, a colon, and the rest of the token — which may be empty, and may hold more colons. */
const OPERATOR = /^([^\s:"]+):(\S*)$/u;

/** The keys are ASCII, so every case of the Turkish i is the one letter (`İN:`, `ıs:`). */
const keyOf = (typed: string): OperatorKey | undefined => {
  const folded = typed.replace(/[İIı]/gu, 'i').toLowerCase();
  return OPERATOR_KEYS.find((key) => key === folded);
};

const operatorIn = (token: string): SearchPart | null => {
  const match = OPERATOR.exec(token);
  const key = match === null ? undefined : keyOf(match[1] ?? '');
  return key === undefined ? null : { kind: 'operator', key, value: match?.[2] ?? '', token };
};

/** What was typed, in order: runs of words and the operators between them. */
export const parseSearch = (text: string): readonly SearchPart[] => {
  const parts: SearchPart[] = [];
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    const space = /^\s+/u.exec(rest)?.[0];
    if (space !== undefined) {
      at += space.length;
      continue;
    }
    const close = rest.startsWith('"') ? rest.indexOf('"', 1) : -1;
    if (close !== -1) {
      const phrase = rest.slice(1, close).trim();
      if (phrase !== '') parts.push({ kind: 'words', text: phrase });
      at += close + 1;
      continue;
    }
    const token = /^\S+/u.exec(rest)?.[0] ?? rest;
    at += token.length;
    parts.push(operatorIn(token) ?? { kind: 'words', text: token });
  }
  return parts;
};

/** Who and what an operator can name: what the client already holds. */
export interface Directory {
  readonly channels: readonly Channel[];
  readonly members: readonly WorkspaceMember[];
  readonly meId: string;
  /** The instant a `YYYY-MM-DD` day begins in the viewer's time zone (`Formatters.dayStart`). */
  readonly dayStart: (isoDay: string) => string;
}

/** The structured search: the words, where, from whom, and the rest of the filters. */
export interface SearchState {
  readonly words: string;
  readonly channelId: string | null;
  readonly authorId: string | null;
  readonly filters: SearchFilters;
}

/** Why an operator was searched for as words. */
export type Unread = 'channel' | 'person' | 'value';

type Reading =
  | { readonly channelId: string }
  | { readonly authorId: string }
  | { readonly filters: SearchFilters }
  | { readonly unread: Unread };

/** A name as typed against one held: case, marks and the dotless ı do not matter (#702). */
const named = (typed: string, held: string): boolean => typed !== '' && fold(typed) === fold(held);

const channelNamed = (value: string, channels: readonly Channel[]): Channel | undefined => {
  if (value.startsWith('@')) {
    const handle = value.slice(1);
    return channels.find(
      (channel) =>
        channel.type === 'direct_message' &&
        channel.peers.length === 1 &&
        channel.peer !== null &&
        named(handle, channel.peer.username),
    );
  }
  const name = value.startsWith('#') ? value.slice(1) : value;
  return channels.find(
    (channel) => channel.type !== 'direct_message' && named(name, channel.name ?? ''),
  );
};

const personNamed = (value: string, directory: Directory): string | undefined => {
  const handle = value.startsWith('@') ? value.slice(1) : value;
  const member = directory.members.find((each) => named(handle, each.user.username));
  if (member !== undefined) return member.user.id;
  return fold(handle) === 'me' ? directory.meId : undefined;
};

/** Days before the epoch hold no messages, and past 9998 the day after has no ISO spelling. */
const FIRST_YEAR = 1970;
const LAST_YEAR = 9998;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DAY_MS = 86_400_000;

/** A real calendar day as `YYYY-MM-DD` (no 2026-02-30), or null. */
const dayOf = (value: string): string | null => {
  const year = Number(DAY.exec(value)?.[1]);
  if (!(year >= FIRST_YEAR && year <= LAST_YEAR)) return null;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : null;
};

const dayAfter = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

const FLAGS: Readonly<Record<string, Readonly<Record<string, SearchFilters>>>> = {
  has: { code: { kind: 'code' }, file: { kind: 'file' }, files: { kind: 'file' } },
  is: {
    resolved: { status: 'resolved' },
    open: { status: 'open' },
    question: { question: 'yes' },
  },
};

const dates = (key: 'before' | 'after' | 'on', day: string, directory: Directory): Reading => {
  // Each is a whole day in the viewer's time zone: before it, after it, or the day itself (D-224).
  if (key === 'before') return { filters: { until: directory.dayStart(day) } };
  const next = directory.dayStart(dayAfter(day));
  return key === 'after'
    ? { filters: { since: next } }
    : { filters: { since: directory.dayStart(day), until: next } };
};

const read = (part: Extract<SearchPart, { kind: 'operator' }>, directory: Directory): Reading => {
  const { key, value } = part;
  // `from:` with nothing after it is half typed, not a filter for nobody.
  if (value === '') return { unread: 'value' };
  switch (key) {
    case 'in': {
      const channel = channelNamed(value, directory.channels);
      return channel === undefined ? { unread: 'channel' } : { channelId: channel.id };
    }
    case 'from': {
      const authorId = personNamed(value, directory);
      return authorId === undefined ? { unread: 'person' } : { authorId };
    }
    case 'has':
    case 'is': {
      const filters = FLAGS[key]?.[fold(value)];
      return filters === undefined ? { unread: 'value' } : { filters };
    }
    case 'repo': {
      const filters = { repository: value };
      return Value.Check(SearchFilters, filters) ? { filters } : { unread: 'value' };
    }
    case 'before':
    case 'after':
    case 'on': {
      const day = dayOf(value);
      return day === null ? { unread: 'value' } : dates(key, day, directory);
    }
  }
};

/**
 * What a typed line asks for, over what was already chosen: each operator that can be read sets its
 * filter — the last one of a kind winning — and the rest is the words, in the order typed.
 */
export const liftOperators = (
  text: string,
  base: SearchState,
  directory: Directory,
): SearchState => {
  let state: SearchState = base;
  const words: string[] = [];
  for (const part of parseSearch(text)) {
    if (part.kind === 'words') {
      words.push(part.text);
      continue;
    }
    const reading = read(part, directory);
    if ('unread' in reading) words.push(part.token);
    else if ('channelId' in reading) state = { ...state, channelId: reading.channelId };
    else if ('authorId' in reading) state = { ...state, authorId: reading.authorId };
    else state = { ...state, filters: { ...state.filters, ...reading.filters } };
  }
  return { ...state, words: words.join(' ') };
};

/**
 * Words as the field shows them: a token that would be read as an operator is quoted, so pressing
 * Enter again searches for the same thing rather than turning words back into a filter. One that
 * cannot be read stays bare, to be corrected and read the next time.
 */
export const asTyped = (words: string, directory: Directory): string =>
  words.replace(/\S+/gu, (token) => {
    const part = operatorIn(token);
    return part?.kind !== 'operator' || 'unread' in read(part, directory) ? token : `"${token}"`;
  });

export interface UnreadOperator {
  readonly token: string;
  readonly value: string;
  readonly why: Unread;
}

/**
 * The operators the words still hold that cannot be read — said beside the results, since they were
 * searched for as words. One the words hold although it could be read was quoted on purpose, and is
 * not said.
 */
export const unreadOperators = (words: string, directory: Directory): readonly UnreadOperator[] =>
  parseSearch(words).flatMap((part) => {
    if (part.kind === 'words') return [];
    const reading = read(part, directory);
    return 'unread' in reading
      ? [{ token: part.token, value: part.value, why: reading.unread }]
      : [];
  });

/** Why a search cannot be asked as it stands, or null when it can. */
export type SearchProblem = 'tooShort' | 'tooLong' | 'range';

export const searchProblem = (state: SearchState): SearchProblem | null => {
  if (state.words.length > SEARCH_QUERY_MAX) return 'tooLong';
  const narrowed =
    Object.keys(state.filters).length > 0 || state.channelId !== null || state.authorId !== null;
  if (state.words === '' ? !narrowed : state.words.length < SEARCH_QUERY_MIN) return 'tooShort';
  const { since, until } = state.filters;
  if (since !== undefined && until !== undefined && Date.parse(since) >= Date.parse(until)) {
    return 'range';
  }
  return null;
};
