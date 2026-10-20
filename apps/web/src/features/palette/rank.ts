/**
 * What the palette shows for a query: matched, ranked, capped, grouped.
 *
 * **Groups keep their fixed order** — Views, Channels, People, Settings — because a
 * person who has used the palette twice knows where to look, and a list that
 * reorders its sections by score is a list nobody learns. **Inside a group** the best
 * match is first, then the more recently active, then alphabetical, which is also
 * a total order: the same query always gives the same list. Views and Settings are the
 * exception: a short menu in an order of its own, so a query only picks which of it shows.
 *
 * With nothing typed the palette is a menu of where a person probably wants to go:
 * every view and setting, and the few most recent channels and people — not two
 * thousand names.
 *
 * With a query the results are capped (`RESULT_CAP`) across the groups, taking the
 * best matches overall. The cap is there for the reader, not the machine: past fifty
 * results nobody scrolls, they type another letter.
 */
import type { User } from '@purlay/types';
import type { GlyphName } from '../../components/icon';
import { matchText } from './match';

/** `search` holds one row, searching the messages for what was typed: always last. */
export type PaletteGroup = 'views' | 'channels' | 'people' | 'settings' | 'search';

/** The order the groups are shown in. */
export const GROUPS = [
  'views',
  'channels',
  'people',
  'settings',
  'search',
] as const satisfies readonly PaletteGroup[];

/** The most results a query can show. */
export const RESULT_CAP = 50;

/** How many recent channels and people an empty query offers. */
export const EMPTY_QUERY_RECENT = 5;

export interface PaletteItem {
  readonly id: string;
  readonly group: PaletteGroup;
  /** What it is called, and what a typed query is matched and emphasised against. */
  readonly label: string;
  /** Extra words a query may match without being shown (a person's username). */
  readonly keywords?: readonly string[];
  /** A quiet second line: where a view leads, what a setting is now. */
  readonly hint?: string;
  readonly glyph: GlyphName;
  /** A person: the row shows their avatar where other rows show the glyph (the glyph is still the fallback for assistive text). */
  readonly avatar?: { readonly name: string; readonly username: string };
  /** A group conversation: its people, drawn as its faces where other rows show the glyph (D-167). */
  readonly faces?: readonly User[];
  /** When it was last active, ISO; `''` when that means nothing (a setting). Newest first. */
  readonly recency: string;
  /** Do it. A promise means the palette stays open until it settles. */
  readonly run: () => void | Promise<void>;
}

export interface Shown {
  readonly item: PaletteItem;
  /** Positions in `item.label` to emphasise; empty when only a keyword matched. */
  readonly positions: readonly number[];
}

const byGroup = (a: Shown, b: Shown): number =>
  GROUPS.indexOf(a.item.group) - GROUPS.indexOf(b.item.group);

/**
 * Groups whose order is the builder's: a match decides whether a row is shown, not where — Deep
 * Work's whiles stay shortest to longest, where the score put "1 hour" before "30 minutes" for
 * being the shorter label.
 */
const KEEP_ORDER: readonly PaletteGroup[] = ['views', 'settings'];

const newestFirst = (a: PaletteItem, b: PaletteItem): number =>
  a.recency < b.recency ? 1 : a.recency > b.recency ? -1 : a.label.localeCompare(b.label);

export const rank = (items: readonly PaletteItem[], query: string): readonly Shown[] => {
  const q = query.trim();
  if (q === '') {
    const sorted = [...items].sort(newestFirst);
    const recent = (group: PaletteGroup): Shown[] =>
      sorted
        .filter((item) => item.group === group)
        .slice(0, EMPTY_QUERY_RECENT)
        .map((item) => ({ item, positions: [] }));
    const all = (group: PaletteGroup): Shown[] =>
      items.filter((item) => item.group === group).map((item) => ({ item, positions: [] }));
    return [...all('views'), ...recent('channels'), ...recent('people'), ...all('settings')];
  }

  const scored: { shown: Shown; score: number }[] = [];
  for (const item of items) {
    const label = matchText(q, item.label);
    let best = label;
    for (const word of item.keywords ?? []) {
      const other = matchText(q, word);
      if (other !== null && (best === null || other.score > best.score)) {
        best = { score: other.score, positions: [] };
      }
    }
    if (best !== null) {
      scored.push({ shown: { item, positions: label?.positions ?? [] }, score: best.score });
    }
  }
  scored.sort((a, b) => b.score - a.score || newestFirst(a.shown.item, b.shown.item));
  // Array.prototype.sort is stable, so the best match of a group stays first inside it.
  const given = new Map(items.map((entry, index) => [entry, index]));
  const place = (shown: Shown): number => given.get(shown.item) ?? 0;
  return scored
    .slice(0, RESULT_CAP)
    .map((entry) => entry.shown)
    .sort((a, b) => byGroup(a, b) || (KEEP_ORDER.includes(a.item.group) ? place(a) - place(b) : 0));
};
