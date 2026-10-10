/**
 * Who is speaking: initials on a tint (`UX.md` §3, D-100).
 *
 * The tint is chosen from the username, so one person is one colour everywhere and nothing is
 * stored, fetched or able to fail to load. It is decorative — the name is always beside it — so
 * it is hidden from a screen reader, which would otherwise read the letters before the name.
 * There is no presence dot because there is no presence (`UX.md` §2).
 */
import { cn } from './cn';

const TINTS = [
  'bg-avatar-1',
  'bg-avatar-2',
  'bg-avatar-3',
  'bg-avatar-4',
  'bg-avatar-5',
  'bg-avatar-6',
] as const;

const SIZES = {
  sm: 'size-avatar-sm text-caption',
  md: 'size-avatar text-label',
  lg: 'size-avatar-lg text-heading',
} as const;

/** A string's tint, stable across sessions and machines: a small, well-spread integer hash. */
export const tintOf = (username: string): number => {
  let hash = 0;
  for (const character of username) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 997;
  return hash % TINTS.length;
};

/** One or two letters: the first of each of the first two words, or the first two of one word. */
export const initialsOf = (name: string): string => {
  const words = name
    .trim()
    .split(/[\s._-]+/u)
    .filter((word) => word !== '');
  const [first, second] = words;
  if (first === undefined) return '?';
  const letters =
    second === undefined
      ? Array.from(first).slice(0, 2).join('')
      : `${Array.from(first)[0] ?? ''}${Array.from(second)[0] ?? ''}`;
  return letters.toLocaleUpperCase();
};

interface AvatarProps {
  /** What the person is called; the initials come from it. */
  readonly name: string;
  /** What the tint is chosen from: the stable handle, not a display name that can change. */
  readonly username: string;
  readonly size?: keyof typeof SIZES;
  readonly className?: string;
}

export const Avatar = ({
  name,
  username,
  size = 'md',
  className,
}: AvatarProps): React.JSX.Element => (
  <span
    aria-hidden="true"
    className={cn(
      'inline-flex shrink-0 select-none items-center justify-center rounded-pill text-ink',
      TINTS[tintOf(username)],
      SIZES[size],
      className,
    )}
  >
    {initialsOf(name)}
  </span>
);
