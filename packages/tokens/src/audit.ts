/**
 * The judgements that need the whole model rather than one token: is every pair
 * in `pairs.ts` readable in every theme, and has every colour been given a
 * contrast decision? Separate from `parseTokens` because a file can be well formed
 * and still be unreadable — and the two failures want different words.
 */
import { contrastRatio } from './contrast';
import type { Model } from './model';
import { EXEMPT, PAIRS } from './pairs';

export const audit = (model: Model): readonly string[] => {
  const problems: string[] = [];
  const byName = new Map(model.colors.map((color) => [color.name, color]));

  for (const pair of PAIRS) {
    for (const theme of model.themes) {
      const foreground = byName.get(pair.foreground)?.resolved[theme.id];
      const background = byName.get(pair.background)?.resolved[theme.id];
      if (foreground === undefined || background === undefined) {
        problems.push(
          `pairs.ts names ${pair.foreground} on ${pair.background}, and tokens.json lacks one of them`,
        );
        break;
      }
      let ratio: number;
      try {
        ratio = contrastRatio(foreground, background);
      } catch (error) {
        problems.push(
          `${pair.foreground} on ${pair.background} (${theme.id}): ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (ratio < pair.minimum) {
        problems.push(
          `${pair.foreground} on ${pair.background} (${theme.id}) is ${ratio.toFixed(2)}:1, needs ${String(pair.minimum)}:1 — ${pair.why}`,
        );
      }
    }
  }

  const judged = new Set<string>(Object.keys(EXEMPT));
  for (const pair of PAIRS) {
    judged.add(pair.foreground);
    judged.add(pair.background);
  }
  for (const color of model.colors) {
    if (!judged.has(color.name)) {
      problems.push(
        `colour "${color.name}" has no contrast decision: add it to a pair or to EXEMPT in pairs.ts`,
      );
    }
  }
  for (const name of Object.keys(EXEMPT)) {
    if (!byName.has(name)) problems.push(`EXEMPT names "${name}", which is not a colour token`);
  }
  return problems;
};
