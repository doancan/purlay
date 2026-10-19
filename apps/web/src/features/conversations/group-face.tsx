/**
 * A group conversation's face (D-166): its first two other people, the second overlapping the
 * first, and — when there are more — how many more, on a third chip of the same size. Each face
 * is one letter: at this size a second letter is what the overlap would cover.
 *
 * "The first two" are the first two of `peers`, the order of the group's key, which is the order
 * its name is written in, so the faces and the name never disagree. A group is at most ten people
 * (D-127), so there are at most seven more: the count is always one digit and fits the chip, and the
 * face is never taller than one small avatar — the row it sits in keeps its height.
 *
 * Each overlapping piece is cut out of the one behind it by a hairline in the colour of what it is
 * drawn on, so two people with the same tint are still two. Whoever draws it names that surface.
 * Decorative, as an avatar is: the name beside it says who is there.
 */
import type { User } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { Avatar } from '../../ui/avatar';
import { cn } from '../../ui/cn';
import { nameOf } from '../messages/author';

/** What the face is drawn on: the sidebar's row, the row you are in, a page, a selected option. */
export type FaceSurface = 'nav' | 'nav-current' | 'surface' | 'selected';

/** The cut-out's colour: the surface's own, following a sidebar row's hover. */
const EDGE = {
  nav: 'border-hairline border-nav-surface group-hover:border-nav-hover',
  'nav-current': 'border-hairline border-accent',
  surface: 'border-hairline border-surface-100',
  selected: 'border-hairline border-accent-subtle',
} as const satisfies Record<FaceSurface, string>;

/** The "+N" chip: quiet on its surface, legible on it. */
const MORE = {
  nav: 'bg-nav-border text-nav-ink',
  'nav-current': 'bg-nav-border text-nav-ink',
  surface: 'bg-surface-200 text-ink-muted',
  selected: 'bg-surface-200 text-ink-muted',
} as const satisfies Record<FaceSurface, string>;

/** How many faces are drawn before the rest are counted. */
const FACES_SHOWN = 2;

export const GroupFace = ({
  peers,
  surface,
}: {
  /** The group's people other than the caller, in its key's order (`Channel.peers`). */
  readonly peers: readonly User[];
  readonly surface: FaceSurface;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const shown = peers.slice(0, FACES_SHOWN);
  const more = peers.length - shown.length;
  return (
    <span aria-hidden="true" data-group-face="" className="inline-flex shrink-0 items-center">
      {shown.map((person, place) => (
        <Avatar
          key={person.id}
          size="sm"
          name={nameOf(person, t('user.erased'))}
          username={person.username}
          letters={1}
          {...(place === 0 ? {} : { className: cn('-ml-1', EDGE[surface]) })}
        />
      ))}
      {more > 0 && (
        <span
          data-group-more=""
          className={cn(
            '-ml-1 inline-flex size-avatar-sm shrink-0 items-center justify-center rounded-md text-caption font-semibold',
            EDGE[surface],
            MORE[surface],
          )}
        >
          {`+${format.number(more)}`}
        </span>
      )}
    </span>
  );
};
