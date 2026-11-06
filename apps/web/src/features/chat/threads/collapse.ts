/**
 * The one transition in the product that is not instant (`UX.md` §4.3, §9): a thread
 * collapsing when it is resolved.
 *
 * A state change that reorganises the reader's view has to be *seen* to be understood, so
 * the thread folds away over the `duration-collapse` token with the `easing-standard`
 * token, on height and opacity and nothing else. The numbers are the tokens' — read from
 * the page's custom properties at the moment of use, not copied here — which is also how
 * `prefers-reduced-motion` works: the token is `0ms` there (`tokens.css`), so a person who
 * asked for no motion gets none and no code in this file had to ask them.
 *
 * It is the Web Animations API on purpose: the height to fold from is the element's own,
 * measured now, and a CSS class cannot transition to or from `auto`. Where an element
 * cannot animate (the test DOM) or the duration is zero, it resolves at once.
 */

/** A CSS time, `120ms` or `0.12s`, in milliseconds; 0 for anything else. */
export const parseDuration = (value: string): number => {
  const match = /^\s*(\d*\.?\d+)(ms|s)\s*$/.exec(value);
  if (match === null) return 0;
  const [, amount = '0', unit = 'ms'] = match;
  return Number(amount) * (unit === 's' ? 1000 : 1);
};

const token = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name);

/** How long a collapse takes right now, honouring the reduced-motion override of the token. */
export const collapseDuration = (): number => parseDuration(token('--duration-collapse'));

/** Folds `element` away; resolves when it is done (immediately when there is nothing to animate). */
export const foldAway = async (element: HTMLElement): Promise<void> => {
  const duration = collapseDuration();
  if (duration === 0 || typeof element.animate !== 'function') return;
  const height = element.getBoundingClientRect().height;
  const easing = token('--easing-standard').trim();
  const animation = element.animate(
    [
      { maxHeight: `${String(height)}px`, opacity: 1, overflow: 'hidden' },
      { maxHeight: `${String(0)}px`, opacity: 0, overflow: 'hidden' },
    ],
    { duration, easing: easing === '' ? 'ease' : easing, fill: 'forwards' },
  );
  await animation.finished.catch(() => undefined);
};
