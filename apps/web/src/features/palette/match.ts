/**
 * Fuzzy-ish matching for the palette: what a person typed against what an item is called.
 *
 * Four tiers, strongest first, because what a person expects at the top is what they
 * were *aiming* at and not what merely contains their letters: the name starts with
 * what they typed; a word of it does (`ops` in `team-ops`); it contains it
 * contiguously; its letters appear in order (`dpl` in `deploys`). Case never matters.
 * A shorter name beats a longer one inside a tier — `api` over `api-gateway` for `api`
 * — and the matched positions come back so the list can emphasise them.
 *
 * It is a pure function of two strings and runs in time linear in the text for every
 * tier but the last, which is one pass: filtering two thousand names is a few
 * thousand character comparisons, not a search.
 */

export interface Match {
  /** Higher is better; comparable only between matches of the same query. */
  readonly score: number;
  /** The positions in the text that matched, ascending — for emphasis. */
  readonly positions: readonly number[];
}

/** Where a word may begin: after a separator a name or a person's name uses. */
const WORD_BREAK = /[\s\-_./#@]/;

const TIER = { prefix: 4000, word: 3000, contains: 2000, subsequence: 1000 } as const;

const range = (from: number, length: number): number[] =>
  Array.from({ length }, (_, offset) => from + offset);

/** The first index where `query` begins a word of `text`, or -1. */
const wordStart = (text: string, query: string): number => {
  let at = text.indexOf(query);
  while (at !== -1) {
    const before = text[at - 1];
    if (at === 0 || (before !== undefined && WORD_BREAK.test(before))) return at;
    at = text.indexOf(query, at + 1);
  }
  return -1;
};

export const matchText = (query: string, text: string): Match | null => {
  const q = query.toLowerCase();
  if (q === '') return { score: 0, positions: [] };
  const t = text.toLowerCase();
  // A shorter name is closer to what was typed; the penalty never crosses a tier.
  const closeness = Math.max(0, 999 - (t.length - q.length));

  if (t.startsWith(q)) return { score: TIER.prefix + closeness, positions: range(0, q.length) };
  const word = wordStart(t, q);
  if (word !== -1) return { score: TIER.word + closeness, positions: range(word, q.length) };
  const inside = t.indexOf(q);
  if (inside !== -1)
    return { score: TIER.contains + closeness, positions: range(inside, q.length) };

  const positions: number[] = [];
  let from = 0;
  for (const letter of q) {
    const found = t.indexOf(letter, from);
    if (found === -1) return null;
    positions.push(found);
    from = found + 1;
  }
  // Letters packed together beat letters spread across the name.
  const spread = (positions.at(-1) ?? 0) - (positions[0] ?? 0) - (q.length - 1);
  return { score: TIER.subsequence + Math.max(0, 999 - spread), positions };
};
