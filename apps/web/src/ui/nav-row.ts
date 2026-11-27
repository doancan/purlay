import { cn } from './cn';

/**
 * A row of the navigation column: 32px (`size-row`), the sidebar's rhythm, 44px where a finger is the pointer.
 * The settings' navigation and the server administration's are the same column, so they share the row; what
 * a row looks like when it is the page you are on is each list's to say.
 */
export const navRowClasses =
  'flex h-row w-full items-center gap-2 rounded-lg px-2 text-body transition-colors duration-hover ease-standard max-narrow:h-touch';

/**
 * The bar at the leading edge of the place you are in. The selected tone alone cannot carry it: in the light and
 * midnight themes the tone that keeps every text pair at AA sits barely a step from the hover's, so where you are
 * read the same as where the pointer is. The bar does not depend on that step. Its row must be `relative`.
 */
export const navMarkerShapeClasses =
  'before:absolute before:inset-y-2 before:rounded-pill before:border-l-marker before:border-accent-text';

/** The bar inside a sidebar row, at the row's own edge. */
export const navMarkerClasses = cn(navMarkerShapeClasses, 'before:left-0');

/**
 * Where the person is, in a settings column: the selected tone, the label in weight and the mark in the accent. No
 * bar: a page of settings is a list of sections read top to bottom, and the tone, against a hover that is a neutral
 * step, already tells the two apart.
 */
export const navRowHereClasses =
  'bg-nav-selected font-semibold text-nav-ink [&>svg]:text-accent-text';

/** Anywhere else: the quiet tone, lifted a step under the pointer. */
export const navRowAwayClasses = 'text-nav-ink-muted hover:bg-nav-hover hover:text-nav-ink';
