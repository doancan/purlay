/**
 * A key, as it is printed on the keyboard.
 *
 * The product is keyboard-first (`UX.md` §7), so a shortcut is shown wherever it
 * exists — in a menu item, a tooltip, a button — and it is shown the same way
 * everywhere: the mono face, a hairline edge, the muted ink. One component, so
 * "⌘K" never ends up styled three ways.
 *
 * A pointer that is a finger has no keyboard to press it on, so there it is not shown at all.
 */
import { cn } from './cn';

const kbdClasses =
  'inline-flex items-center rounded-sm border-hairline px-1 font-mono text-caption pointer-coarse:hidden';

/** On the conversation's ground, or on the navigation's tone (D-118). */
const toneClasses = {
  page: 'border-border-subtle bg-surface-050 text-ink-subtle',
  nav: 'border-nav-border bg-nav-hover text-nav-ink-muted',
} as const;

interface KbdProps {
  readonly className?: string;
  readonly tone?: keyof typeof toneClasses;
  readonly children: React.ReactNode;
}

export const Kbd = ({ className, tone = 'page', children }: KbdProps): React.JSX.Element => (
  <kbd className={cn(kbdClasses, toneClasses[tone], className)}>{children}</kbd>
);
