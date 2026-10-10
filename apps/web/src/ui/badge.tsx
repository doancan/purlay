/**
 * The mention count — the only badge in the product (`UX.md` §2).
 *
 * "Nothing else gets a badge": an unread channel is bold, not badged, because a
 * count on everything is a count on nothing. This one is a pill (`rounded-pill`
 * is reserved for it and the presence dot), `h-badge` tall and at least as wide:
 * one digit is a circle, two are not.
 *
 * The number alone says nothing to a screen reader, so the label is required —
 * "2 unread mentions", built by the caller in the right language and plural.
 */
const badgeClasses =
  'inline-flex h-badge min-w-badge items-center justify-center rounded-pill bg-accent px-1 text-label text-on-accent';

interface BadgeProps {
  readonly count: number;
  /** "2 unread mentions" — what the number means. */
  readonly label: string;
}

export const Badge = ({ count, label }: BadgeProps): React.JSX.Element => (
  <span role="img" aria-label={label} className={badgeClasses}>
    <span aria-hidden="true">{count}</span>
  </span>
);
