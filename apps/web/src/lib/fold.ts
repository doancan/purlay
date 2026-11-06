/**
 * For comparison only: no case, no marks, and the dotless `ı` as `i`. A Turkish team types `dogancan` for
 * Doğancan on a keyboard with and without the letters, so a person is found by it in the mention list, the
 * palette and the member filters alike.
 */
export const fold = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ı/gu, 'i');
