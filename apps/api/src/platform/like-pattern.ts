/** `%`, `_` and `\` are what a person typed, not a pattern: escaped for `ILIKE`'s default escape. */
export const literalPattern = (words: string): string =>
  `%${words.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
