/**
 * How names and labels are ordered: by the language the person chose, not the one their browser reports.
 *
 * A Turkish reader on an English browser otherwise gets ç, ş, ğ, ı and İ sorted by the root collation, and a
 * list that is in order to the browser is out of order to them. The language provider says which one is showing
 * (`setCollationLocale`); everything that orders text asks here, so it is said once. One `Intl.Collator`, built
 * when the language changes, is also a good deal cheaper in a sort than `localeCompare`, which builds one per
 * comparison.
 */
let collator = new Intl.Collator();

/** Called by the language provider when the language showing changes. */
export const setCollationLocale = (locale: string): void => {
  collator = new Intl.Collator(locale);
};

/** `Array.prototype.sort`'s comparator for text, in the language showing. */
export const compareText = (a: string, b: string): number => collator.compare(a, b);
