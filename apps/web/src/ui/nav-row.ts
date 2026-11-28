/**
 * A row of the navigation column: 32px (`size-row`), the sidebar's rhythm, 44px where a finger is the pointer.
 * The settings' navigation and the server administration's are the same column, so they share the row; what
 * a row looks like when it is the page you are on is each list's to say.
 */
export const navRowClasses =
  'flex h-row w-full items-center gap-2 rounded-lg px-2 text-body transition-colors duration-hover ease-standard max-narrow:h-touch';

/**
 * Where the person is, in any navigation column: the selected tone, the label in weight and the mark in the accent. No
 * bar at the edge (D-361): the blue tone against a hover that is a neutral step, and the weight, tell the two apart.
 */
export const navRowHereClasses =
  'bg-nav-selected font-semibold text-nav-ink [&>svg]:text-accent-text';

/** Anywhere else: the quiet tone, lifted a step under the pointer. */
export const navRowAwayClasses = 'text-nav-ink-muted hover:bg-nav-hover hover:text-nav-ink';
