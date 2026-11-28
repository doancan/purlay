/**
 * A shortcut, as keys printed on the keyboard.
 *
 * The product is keyboard-first (`UX.md` §7), so a shortcut is shown wherever it
 * exists — in a menu item, a tooltip, a button — and it is shown the same way
 * everywhere: each key its own cap, as tall as every other cap, on a quiet ground with
 * a hairline edge, the glyphs of this platform (`keys.ts`: ⌘ ⇧ ↵ on a Mac, Ctrl Shift
 * Enter elsewhere). One component, so "⌘K" never ends up styled three ways.
 *
 * A chord is the HTML spec's nested `<kbd>`: one per key inside one for the whole. Off a Mac
 * the `+` between keys is said but not drawn — a screen reader says "Ctrl plus K", the eye
 * sees two caps — and on a Mac nothing is between them, as the Mac writes ⌘K.
 *
 * A device that is only touch has no keyboard to press it on, so there it is not shown at all
 * (`touch-only:`) — except in the reference of shortcuts, which
 * a person reads to learn them for the keyboard they will use (`touch="show"`).
 */
import { Fragment } from 'react';
import { Icon, type GlyphName } from '../components/icon';
import { cn } from './cn';
import { currentPlatformIsMac, formatShortcut, isSingleCharacter, printsAsMac } from './keys';
import { VisuallyHidden } from './visually-hidden';

/** One cap, every one the same height: square for a glyph or a letter, wider for a word. */
const capClasses =
  'inline-flex h-kbd min-w-kbd items-center justify-center rounded-sm border-hairline font-sans text-caption font-medium tabular-nums whitespace-nowrap';

/** A glyph's cap is exactly square, however wide the glyph (⇧ is wider than ⌘); a word's is padded. */
const widthOf = (key: string): string => (isSingleCharacter(key) ? 'w-kbd' : 'px-1');

/**
 * Off a Mac the keys print words, and the two that name a line (Enter, Shift) carry their arrow too, so a hint reads at a
 * glance as a Windows or Linux keyboard's own keys; a Mac prints ⌘ ⇧ ↵ as glyphs and needs none (D-361).
 */
const KEY_ICONS: Readonly<Record<string, GlyphName>> = { Enter: 'key-enter', Shift: 'key-shift' };

/**
 * The row of key hints under a list (the commands, the `@` people, the palette). It wraps: side by
 * side where they fit, each hint a line of its own where they do not — never two narrow columns. A row
 * of nothing but keys adds `touch-only:hidden`, or a finger is left the words without their keys.
 *
 * One line is a control's height, its hairline included (the box is `border-box`): a cap and 8px of padding
 * came to 37px with the line, off the 4px grid every other row is on.
 */
export const keyHintsClasses =
  'flex min-h-control flex-wrap items-center gap-x-4 gap-y-1 border-t-hairline border-border-subtle px-4 py-1 text-caption text-ink-muted';

/**
 * On the conversation's ground, or in the navigation (D-118). The cap is the same quiet key in both: a
 * nav-hover fill read as a solid grey block on the jump field's ground and vanished into it on hover, so
 * only the ink follows the navigation's tone.
 */
const toneClasses = {
  page: 'border-border-subtle bg-surface-050 text-ink-muted',
  nav: 'border-border-subtle bg-surface-050 text-nav-ink-muted',
} as const;

interface KbdProps {
  readonly className?: string;
  readonly tone?: keyof typeof toneClasses;
  /** The shortcut, in either spelling: `Mod+K`, `Ctrl+Shift+R`, `⌘K`, `Esc`. */
  readonly children: string;
  /** Whose keyboard to print it for; this browser's unless a caller already knows (the reference, a test). */
  readonly mac?: boolean;
  /** On a device that is only touch: hidden, as a key there is nothing to press, or shown, in the reference. */
  readonly touch?: 'hide' | 'show';
}

export const Kbd = ({
  className,
  tone = 'page',
  children,
  mac = currentPlatformIsMac(),
  touch = 'hide',
}: KbdProps): React.JSX.Element => {
  const asMac = printsAsMac(children, mac);
  const touchClasses = touch === 'hide' ? 'touch-only:hidden' : undefined;
  const caps = formatShortcut(children, asMac);
  const cap = (key: string, extra?: string): React.JSX.Element => {
    // Off a Mac the two keys that name a line carry their arrow, so the cap is a glyph and a word.
    const icon = asMac ? undefined : KEY_ICONS[key];
    return (
      <kbd
        className={cn(
          capClasses,
          widthOf(key),
          toneClasses[tone],
          icon !== undefined && 'gap-1',
          extra,
        )}
      >
        {icon === undefined ? null : <Icon name={icon} size="sm" />}
        {key}
      </kbd>
    );
  };
  if (caps.length <= 1) return cap(caps[0] ?? children, cn(touchClasses, className));
  return (
    <kbd className={cn('inline-flex items-center gap-1', touchClasses, className)}>
      {caps.map((key, at) => (
        // A chord may name a key twice (`Ctrl++`), so a cap is keyed by its place; caps never reorder.
        <Fragment key={at}>
          {at > 0 && !asMac ? <VisuallyHidden>+</VisuallyHidden> : null}
          {cap(key)}
        </Fragment>
      ))}
    </kbd>
  );
};
