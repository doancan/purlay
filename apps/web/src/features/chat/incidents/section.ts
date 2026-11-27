/**
 * The incident panel's parts drawn alike: each section the same inset, divided from the one above by a
 * hairline (never from the panel's header), its heading in one style, its fields the shape a text field is.
 */

/** A section of the panel: severity and status, who is responding, the runbook, the postmortem, the timeline. */
export const sectionClasses =
  'flex flex-col gap-2 px-4 py-4 not-first:border-t-hairline border-border-subtle';

/** A section's heading, and the name above a group of choices. */
export const headingClasses = 'text-label font-semibold text-ink';

/** A field the person types in: the edge, ground and inset `ui/text-field` gives a text field. */
export const fieldClasses =
  'w-full rounded-md border-hairline border-border-strong bg-surface-100 px-3 text-body text-ink placeholder:text-ink-muted read-only:bg-surface-200 max-narrow:text-title max-narrow:font-normal';
