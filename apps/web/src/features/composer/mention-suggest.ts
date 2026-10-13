/**
 * The `@` autocomplete's half that knows no DOM (`UX.md` §5): where a mention is being typed, who it
 * may be, and what choosing somebody writes into the box.
 *
 * **It only ever writes `@username`** — the shape the server resolves and the client highlights
 * (`mentionsIn`, `@purlay/markdown`). A display name is how a person is found, never what is sent:
 * names change and repeat, handles do not.
 *
 * **Folded, not merely lower-cased.** A Turkish team types `@dogancan` for Doğancan and `@isil` for
 * Işıl, on keyboards with and without the letters; both sides of a comparison lose their marks
 * (`ğ` → `g`, `ş` → `s`, `ç` → `c`, `ö` → `o`, `ü` → `u`, `İ` → `i`) and the dotless `ı` becomes `i`.
 *
 * Every scan is linear and bounded: the box holds up to sixteen thousand characters, and a query
 * longer than a handle could be is not a query.
 */
import { BROADCAST_NAMES } from '@purlay/markdown';
import type { User } from '@purlay/types';
import { insideFence } from './composer-text';

/** The most people the list shows: past this a person types another letter, they do not scroll. */
export const SUGGESTIONS_MAX = 8;

/** Longer than any handle (39) or display name a person would type to find somebody. */
const QUERY_MAX = 64;

/** What may not stand before the `@` — the same letters `mentionsIn` refuses there (`a@b.c` is an address). */
const GLUED = /[\p{L}\p{N}_@`]/u;

/** What a handle is written with: a caret before one of these is inside a name, not at its end. */
const HANDLE_LETTER = /[\p{L}\p{N}_-]/u;

/** A mention being typed: the `@` at `start`, and what follows it up to the caret. */
export interface MentionQuery {
  readonly start: number;
  readonly query: string;
}

/**
 * The mention the caret is at the end of, or null. At least one character after the `@` — a lone
 * `@` is still punctuation — and none of them space or another `@`; never inside a code fence,
 * where an `@` is quoted, not addressed.
 * The caret must be at the end of the name: one that has more name after it is being moved
 * through, not written.
 */
export const mentionQuery = (text: string, caret: number): MentionQuery | null => {
  const from = Math.max(0, caret - QUERY_MAX - 1);
  let at = caret - 1;
  while (at >= from) {
    const character = text.charAt(at);
    if (character === '@') break;
    if (/\s/u.test(character)) return null;
    at -= 1;
  }
  if (at < from || text.charAt(at) !== '@') return null;
  const query = text.slice(at + 1, caret);
  if (query === '') return null;
  // Inside a name already written, choosing would leave the rest of it behind (`@alice ice`).
  if (HANDLE_LETTER.test(text.charAt(caret))) return null;
  if (at > 0 && GLUED.test(text.charAt(at - 1))) return null;
  if (insideFence(text.slice(0, at))) return null;
  return { start: at, query };
};

/** For comparison only: no case, no marks, and the dotless `ı` as `i`. */
export const fold = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ı/gu, 'i');

/** Where a word starts in a name: its first letter, or one after a space or a separator. */
const startsAWord = (name: string, query: string): boolean =>
  name.split(/[\s\-_.]+/u).some((word) => word.startsWith(query));

/**
 * The people whose name or handle matches, best first: the handle typed out exactly, then a handle or
 * a name that *starts* with what
 * was typed, then one with a word that does (`chen` for Alice Chen), then one that contains it.
 * Inside a tier alphabetical by name, so the same letters always give the same list.
 *
 * **A handle typed out in full, matching nobody else, offers nothing.** There is nothing left to
 * complete, and a list would take the Enter that sends the message (`UX.md` §5).
 */
export const suggest = (people: readonly User[], query: string): readonly User[] => {
  const q = fold(query);
  if (q === '') return [];
  const ranked: { readonly person: User; readonly tier: number }[] = [];
  for (const person of people) {
    const handle = fold(person.username);
    const name = fold(person.displayName);
    // A handle typed out exactly is first, above everything that merely starts with it: `@ali`
    // then Enter mentions Ali, never Alice because her name sorts first.
    const tier =
      handle === q
        ? -1
        : handle.startsWith(q) || name.startsWith(q)
          ? 0
          : startsAWord(name, q) || startsAWord(handle, q)
            ? 1
            : handle.includes(q) || name.includes(q)
              ? 2
              : null;
    if (tier !== null) ranked.push({ person, tier });
  }
  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.person.displayName.localeCompare(b.person.displayName) ||
      a.person.username.localeCompare(b.person.username),
  );
  const [only, ...others] = ranked;
  if (only !== undefined && others.length === 0 && fold(only.person.username) === q) return [];
  return ranked.slice(0, SUGGESTIONS_MAX).map((entry) => entry.person);
};

/**
 * Who may be offered: never the writer (the server tells nobody about naming themselves), never a
 * handle the composer would refuse to send (D-12), and each person once.
 */
export const offerable = (people: readonly User[], selfId: string): readonly User[] => {
  const seen = new Set<string>();
  return people.filter((person) => {
    if (person.id === selfId || seen.has(person.id)) return false;
    if (BROADCAST_NAMES.has(person.username.toLowerCase())) return false;
    seen.add(person.id);
    return true;
  });
};

/**
 * The box after somebody is chosen: what was typed after the `@` becomes their handle and one space,
 * and the caret waits after it — the rest of the text, whatever it was, is left exactly as it was.
 */
export const insertMention = (
  text: string,
  mention: MentionQuery,
  username: string,
): { readonly text: string; readonly caret: number } => {
  const end = mention.start + 1 + mention.query.length;
  const written = `@${username} `;
  const rest = text.slice(end);
  // One space between the handle and what follows it, not two.
  const after = rest.startsWith(' ') ? rest.slice(1) : rest;
  return {
    text: `${text.slice(0, mention.start)}${written}${after}`,
    caret: mention.start + written.length,
  };
};
