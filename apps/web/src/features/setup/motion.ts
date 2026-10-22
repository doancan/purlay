/**
 * The wizard's motion, and the one place that decides whether there is any (UX §11).
 *
 * Under `prefers-reduced-motion: reduce` nothing animates: the step simply changes. The lengths are
 * tokens that are 0ms under the same preference, so the stylesheet already keeps still; this hook is
 * the second lock, and the one a test can see — with it, a class that animates is not on the element
 * at all, rather than present and made instant.
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

const snapshot = (): boolean => media()?.matches ?? false;

/** Whether the person asked for less motion. */
export const useReducedMotion = (): boolean =>
  useSyncExternalStore(subscribe, snapshot, () => false);

/** The movements the wizard has; each is a class of `index.css`. */
export type Movement = 'step-in' | 'step-back' | 'mark-settle' | 'nudge';

const CLASSES: Record<Movement, string> = {
  'step-in': 'animate-step-in',
  'step-back': 'animate-step-back',
  'mark-settle': 'animate-mark-settle',
  nudge: 'animate-nudge',
};

/** The class that plays `movement`, or nothing under reduced motion. */
export const movementClass = (movement: Movement, reduced: boolean): string =>
  reduced ? '' : CLASSES[movement];
