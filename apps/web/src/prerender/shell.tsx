/**
 * The application frame as HTML, for the first response (D-50, #141).
 *
 * Cold load is met by shipping less, not by rendering elsewhere — and the part that
 * can be shipped before any script is the frame: the sidebar, the header and a few
 * rows of the feed, as real layout. This renders `AppSkeleton` (no hooks, no words, the
 * same width tokens as the real frame) to a string at build time, and `inject` puts it
 * inside `#root` of the built `index.html`. The page paints immediately; the client
 * mounts with `createRoot`, which replaces the skeleton with the real frame, so the
 * layout has to match and nothing moves — the browser test photographs the HTML with
 * JavaScript off to prove the shapes are there.
 *
 * It is not hydration. The optimistic message model owns client state (D-18), and a
 * hydration boundary is exactly where that assumption would break; the skeleton is
 * disposable by design.
 */
import { renderToString } from 'react-dom/server';
import { AppSkeleton } from '../app/skeleton';

export const ROOT = '<div id="root"></div>';

/** The skeleton as markup. */
export const renderShell = (): string => renderToString(<AppSkeleton />);

const placing = (occurrences: number): string =>
  occurrences === 0
    ? `index.html has no empty ${ROOT} to render the shell into (already rendered?)`
    : `index.html has ${String(occurrences)} empty roots; expected one`;

/**
 * Puts `markup` inside the empty root. It refuses a page it cannot place the markup in,
 * or one that already has it: a build that silently produced an unrendered page, or two
 * shells, is the failure this exists to make loud.
 */
export const inject = (html: string, markup: string): string => {
  const occurrences = html.split(ROOT).length - 1;
  if (occurrences !== 1) throw new Error(placing(occurrences));
  return html.replace(ROOT, `<div id="root">${markup}</div>`);
};
