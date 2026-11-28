/**
 * Whether the person asked for less motion (`prefers-reduced-motion: reduce`), and the one place that reads it.
 *
 * The lengths of every transition are tokens that are 0ms under the same preference, so the stylesheet already keeps
 * still; this is the second lock, and the one a test can see: with it, a class that animates is not on the element at
 * all, rather than present and made instant. A celebration that is drawn by script asks the same question.
 */
import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/** `window.matchMedia`, absent in an environment that has none — which then asks for no less motion. */
const media = (): MediaQueryList | null =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? null
    : window.matchMedia(QUERY);

const subscribe = (notify: () => void): (() => void) => {
  const list = media();
  list?.addEventListener('change', notify);
  return () => {
    list?.removeEventListener('change', notify);
  };
};

/** Now, for what is drawn once rather than kept in step with the preference. */
export const prefersReducedMotion = (): boolean => media()?.matches ?? false;

export const useReducedMotion = (): boolean =>
  useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
