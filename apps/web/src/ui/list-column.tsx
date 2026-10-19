/**
 * The shape the list screens share (D-158): the inbox, the open questions, search and saved. One
 * centred column at the feed's width (D-119) on a ground a step below its cards, and the lists as cards
 * of rows divided by hairlines — so the four read alike and none drifts into a layout of its own.
 */
import { cn } from './cn';

/** The scrolling column under a screen's header. */
export const ListColumn = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <div className="min-h-0 flex-1 overflow-y-auto bg-surface-000">
    <div className="mx-auto flex w-full max-w-feed flex-col gap-6 px-6 pt-6 pb-10 max-narrow:px-4 max-narrow:pt-4">
      {children}
    </div>
  </div>
);

interface ListCardProps {
  /** Above the card: what the rows are — a day, a channel. */
  readonly heading?: React.ReactNode;
  readonly headingId?: string;
  readonly label?: string;
  readonly children: React.ReactNode;
}

/** A titled list: the heading above, the rows in one card. */
export const ListCard = ({
  heading,
  headingId,
  label,
  children,
}: ListCardProps): React.JSX.Element => (
  <section
    className="flex flex-col gap-2"
    {...(headingId === undefined ? {} : { 'aria-labelledby': headingId })}
  >
    {heading}
    <ul
      {...(label === undefined ? {} : { 'aria-label': label })}
      className="overflow-hidden rounded-xl border-hairline border-border-subtle bg-surface-100 shadow-card"
    >
      {children}
    </ul>
  </section>
);

/** A row of a list card: divided from the one above it, never from the card's edge. */
export const listRowClasses = 'not-first:border-t-hairline border-border-subtle';

/** The button a row is: the whole row, padded, tinted under the pointer. */
export const listButtonClasses = (extra?: string): string =>
  cn(
    'flex w-full items-start gap-3 px-5 py-3 text-left transition-colors duration-hover ease-standard hover:bg-surface-050 max-narrow:px-4',
    extra,
  );
