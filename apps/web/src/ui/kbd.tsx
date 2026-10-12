/**
 * A key, as it is printed on the keyboard.
 *
 * The product is keyboard-first (`UX.md` §7), so a shortcut is shown wherever it
 * exists — in a menu item, a tooltip, a button — and it is shown the same way
 * everywhere: the mono face, a hairline edge, the muted ink. One component, so
 * "⌘K" never ends up styled three ways.
 */
import { cn } from './cn';

const kbdClasses =
  'inline-flex items-center rounded-sm border-hairline border-border-subtle bg-surface-050 px-1 font-mono text-caption text-ink-subtle';

interface KbdProps {
  readonly className?: string;
  readonly children: React.ReactNode;
}

export const Kbd = ({ className, children }: KbdProps): React.JSX.Element => (
  <kbd className={cn(kbdClasses, className)}>{children}</kbd>
);
