/**
 * Joins class names, dropping what is not one.
 *
 * Named `cn` because that is the name the vocabulary check
 * (`styles.test.ts`) reads class lists out of: every string handed to it is
 * judged against the token vocabulary, the same as a `className` literal. A
 * helper with another name would be a place a raw class could hide.
 */
export const cn = (...parts: readonly (string | false | null | undefined)[]): string =>
  parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
