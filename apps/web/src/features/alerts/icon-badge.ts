/**
 * The tab's icon, and an installed app's, say that something needs the person (D-148): the favicon
 * with a dot — which a pinned tab still shows when its title is gone — and the operating system's own
 * badge where the page is installed (`navigator.setAppBadge`).
 *
 * The dot is a second picture beside the favicon, not one drawn on a canvas: the page's security
 * policy loads images from its own origin only (D-39), and a drawn picture is a `data:` address.
 * `favicon.test.ts` holds both pictures to the tokens.
 */

/** The favicon with its dot, served beside it. */
export const WAITING_ICON = '/favicon-waiting.svg';

/**
 * The Badging API, which Chromium and Safari have and Firefox does not: optional by its type, so no
 * call can forget to ask whether it is there (D-113 supports Firefox; D-148).
 */
interface Badging {
  readonly setAppBadge?: (count: number) => Promise<void>;
  readonly clearAppBadge?: () => Promise<void>;
}

/** The operating system's badge of an installed page; a page not installed has none to set. */
const appBadge = (count: number): void => {
  const badging: Badging = navigator;
  const done = count > 0 ? badging.setAppBadge?.(count) : badging.clearAppBadge?.();
  // Refused where the page is not installed, or badges are off: there is then no badge to keep true.
  done?.catch(() => undefined);
};

/** What the page linked before any dot: put back at zero. */
let original: string | null = null;

/** Shows `count` on the icons, or takes it off at zero. */
export const paintIcons = (count: number): void => {
  appBadge(count);
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link === null) return;
  original ??= link.getAttribute('href');
  const wanted = count > 0 ? WAITING_ICON : original;
  if (wanted !== null && link.getAttribute('href') !== wanted) link.setAttribute('href', wanted);
};
