/**
 * Who is speaking: initials on a tint (`UX.md` §3, D-100).
 *
 * The tint is chosen from the username, so one person is one colour everywhere and nothing is
 * stored, fetched or able to fail to load. It is decorative — the name is always beside it — so
 * it is hidden from a screen reader, which would otherwise read the letters before the name.
 * A person online has a dot in its corner (D-136); one offline or unknown has none — the words
 * beside the name say it to a screen reader, never the dot.
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

/** Three sizes, each a rounded square whose corner shrinks with it (D-110). */
const SIZES = {
  sm: 'size-avatar-sm rounded-md text-caption',
  md: 'size-avatar rounded-lg text-caption',
  lg: 'size-avatar-lg rounded-lg text-label',
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
  /** Online now (D-136): a dot in the corner. Undefined or false draws none. */
  readonly online?: boolean | undefined;
}

export const Avatar = ({
  name,
  username,
  size = 'md',
  className,
  online,
}: AvatarProps): React.JSX.Element => (
  <span
    aria-hidden="true"
    data-avatar=""
    className={cn(
      'relative inline-flex shrink-0 select-none items-center justify-center font-semibold text-ink',
      TINTS[tintOf(username)],
      SIZES[size],
      className,
    )}
  >
    {initialsOf(name)}
    {online === true && (
      <span
        data-online=""
        className="absolute -right-1 -bottom-1 size-dot rounded-pill border-hairline border-surface-100 bg-success"
      />
    )}
  </span>
);
