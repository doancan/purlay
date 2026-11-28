/**
 * The shape the list screens share (D-158): the inbox, the open questions, search and saved. One
 * column the screen's full width, from its left edge as the feed is (D-177), on a ground a step below its cards, and the lists as cards
 * of rows divided by hairlines — so the four read alike and none drifts into a layout of its own.
 */
import { Icon, type GlyphName } from '../components/icon';
import { cn } from './cn';
import { LoadingStatus, Skeleton } from './skeleton';
import { SlideTrack } from './slide-track';

/** The scrolling column under a screen's header. */
export const ListColumn = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <div className="min-h-0 flex-1 overflow-y-auto bg-surface-000">
    <div className="flex w-full flex-col gap-6 px-6 pt-6 pb-10 max-narrow:px-4 max-narrow:pt-4">
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

const SKELETON_ROWS = [0, 1, 2] as const;

/**
 * What a list screen's card looks like while it loads (`UX.md` §8): the card itself, with rows of the
 * height, padding and avatar its rows will have, so nothing moves when they land. Every list screen waits
 * in this one shape, in the white card its rows will stand in, never in loose lines on the column's ground.
 */
export const ListSkeleton = ({ label }: { readonly label: string }): React.JSX.Element => (
  <LoadingStatus label={label}>
    <ListCard>
      {SKELETON_ROWS.map((row) => (
        <li
          key={row}
          aria-hidden="true"
          className="flex gap-3 px-5 py-3 not-first:border-t-hairline border-border-subtle max-narrow:px-4"
        >
          <Skeleton className="size-avatar shrink-0 rounded-lg" />
          <span className="flex min-w-0 flex-1 flex-col gap-3 py-1">
            <Skeleton className="w-1/3" />
            <Skeleton className="w-3/4" />
          </span>
        </li>
      ))}
    </ListCard>
  </LoadingStatus>
);

/**
 * The button a row is: the whole row, padded, tinted under the pointer. Its ring is drawn inward: the card clips what
 * overflows it, so an outward ring was cut off at the card's edges and landed on the neighbouring row inside.
 *
 * `extra` adds to the base and must never repeat a utility it already sets (a padding, a gap, an alignment) to
 * change it: `cn` does not merge, so which of two `px-` wins is the stylesheet's order, not the call's.
 */
export const listButtonClasses = (extra?: string): string =>
  cn(
    'flex w-full items-start gap-3 px-5 py-3 text-left transition-colors duration-hover ease-standard hover:bg-surface-050 focus-visible:-outline-offset-focus max-narrow:px-4',
    extra,
  );

interface ListFilterChoice<V extends string> {
  readonly value: V;
  readonly label: string;
  /** A mark before the words, where the choices are kinds of thing a glyph can tell apart at a glance. */
  readonly glyph?: GlyphName;
}

interface ListFilterProps<V extends string> {
  /** What the choice is about, said as the group is entered; also the name the sliding mark is kept by. */
  readonly label: string;
  readonly value: V;
  readonly choices: readonly ListFilterChoice<V>[];
  readonly onChange: (value: V) => void;
}

/**
 * The bar over a list screen (Saved, Inbox, Drafts, Unreads, Followed, Questions, Shared, Search, Issues): a
 * header's height, one hairline under it, the column's gutter. Each screen drew its own copy of these classes, so
 * a change to the bar was nine edits and the nine drifted.
 */
export const ListHeader = ({
  gap = 'md',
  children,
}: {
  readonly gap?: 'sm' | 'md';
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <header
    className={cn(
      'flex h-header shrink-0 items-center border-b-hairline border-border-subtle pr-4 pl-6 max-narrow:pl-4',
      gap === 'sm' ? 'gap-2' : 'gap-3',
    )}
  >
    {children}
  </header>
);

/**
 * Which part of the list is shown — Unread, Archived — at the top of the column, over the rows it
 * filters, in every list screen alike: the chosen one raised on a sunk track, the raised mark sliding to a
 * new choice as the header's Feed | Open questions does (D-247). On a phone it is the column's width, each
 * choice a finger tall, and the chosen one carries its own fill, as the sliding mark is not drawn there.
 * There the choices share the width and say only their words: a glyph is dropped, the chosen one's word is
 * whole, and a word too long for its share is cut short, rather than the track scrolling sideways with its last
 * choices out of sight (the whole word is still the button's name).
 *
 * The segments' corner and the track's add up: a `rounded-md` segment, 4px in on a `rounded-xl` track,
 * is the track's corner drawn again — as the sliding mark is, here and in the header's views.
 */
export const ListFilter = <V extends string>({
  label,
  value,
  choices,
  onChange,
}: ListFilterProps<V>): React.JSX.Element => (
  <SlideTrack
    memory={`list-filter:${label}`}
    role="group"
    aria-label={label}
    className="flex max-w-full self-start overflow-x-auto rounded-xl bg-surface-200 p-1 scrollbar-thin max-narrow:w-full max-narrow:self-stretch"
  >
    {choices.map((choice) => (
      <button
        key={choice.value}
        type="button"
        aria-pressed={value === choice.value}
        onClick={() => {
          onChange(choice.value);
        }}
        className={cn(
          'relative inline-flex h-control items-center justify-center gap-2 whitespace-nowrap rounded-md border-hairline border-transparent px-4 text-label transition-colors duration-hover ease-standard max-narrow:h-touch max-narrow:flex-1 max-narrow:px-2',
          value === choice.value
            ? 'text-ink max-narrow:min-w-fit max-narrow:border-border-default max-narrow:bg-surface-100 max-narrow:shadow-card'
            : 'text-ink-muted hover:text-ink max-narrow:min-w-0',
        )}
      >
        {choice.glyph !== undefined && (
          <span className="inline-flex max-narrow:hidden">
            <Icon name={choice.glyph} />
          </span>
        )}
        <span className="min-w-0 truncate">{choice.label}</span>
      </button>
    ))}
  </SlideTrack>
);
