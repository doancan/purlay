/**
 * Whether the window is narrow, by the same line the stylesheet draws.
 *
 * Below `size-narrow` the sidebar is an overlay (`UX.md` §2). CSS can hide and move it with
 * `max-narrow:`, but an overlay is also a *behaviour* — a trapped focus, a scrim to click,
 * the page behind it hidden from a screen reader — and that has to be switched on by script,
 * on the same side of the same line. The line is not written twice: the width is read from the
 * `--size-narrow` token the build generated, so the stylesheet and this cannot disagree about
 * where "narrow" starts (`max-narrow:` is `width < 900px`, and so is the query below).
 *
 * The browser is an argument, so a test moves the line by hand.
 */
import { createContext, useMemo, useSyncExternalStore } from 'react';

/** The part of `MediaQueryList` this uses. */
interface NarrowQuery {
  readonly matches: boolean;
  readonly addEventListener: (type: 'change', listener: () => void) => void;
  readonly removeEventListener: (type: 'change', listener: () => void) => void;
}

/** Makes the query for a width the token holds (`'900px'`). */
export type NarrowPort = (width: string) => NarrowQuery;

export const browserNarrow: NarrowPort = (width) => window.matchMedia(`(width < ${width})`);

/** The page's port, so a test can move the line without a browser to resize. */
export const NarrowPortContext = createContext<NarrowPort>(browserNarrow);

/** What the build says "narrow" is: the token's value on the root. */
const narrowWidth = (): string =>
  getComputedStyle(document.documentElement).getPropertyValue('--size-narrow').trim();

export const useNarrow = (port: NarrowPort = browserNarrow): boolean => {
  // One query per port for the life of the component: subscribing and reading both use it.
  const query = useMemo(() => port(narrowWidth()), [port]);
  return useSyncExternalStore(
    (listener) => {
      query.addEventListener('change', listener);
      return (): void => {
        query.removeEventListener('change', listener);
      };
    },
    () => query.matches,
  );
};
