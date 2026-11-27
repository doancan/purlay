/**
 * A tooltip — the name of an icon, or a timestamp's full form.
 *
 * Radix does the part hand-written code gets wrong silently: it opens on focus as
 * well as hover, closes on Escape, stays open while the pointer is over it (so
 * the content can be read and selected), and wires `aria-describedby`. What this
 * adds is the look, and one provider's worth of timing for the whole app.
 *
 * **A tooltip is never the only place something is said.** An icon button carries
 * its name in `aria-label` too; the tooltip is for sighted people, who cannot
 * read a label that is not drawn.
 */
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { useRef, useState } from 'react';
import { Kbd } from './kbd';

/** Long enough that moving across a toolbar does not light every tip; short enough to feel answered. */
const OPEN_DELAY_MS = 400;
/** Once one tip is open, the next one right beside it opens at once. */
const SKIP_DELAY_MS = 300;

// A tip's states are delayed-open and instant-open, then closed: it pops in whichever way it opened (D-211).
const contentClasses =
  'z-popover flex items-center gap-2 rounded-lg border-hairline border-border-subtle bg-surface-100 px-2 py-1 text-label text-ink shadow-float animate-pop-in data-[state=closed]:animate-pop-out';

export const TooltipProvider = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <RadixTooltip.Provider delayDuration={OPEN_DELAY_MS} skipDelayDuration={SKIP_DELAY_MS}>
    {children}
  </RadixTooltip.Provider>
);

/** A trigger whose menu is open: a tip over it would cover the menu's first items, and say what is already open. */
const opensAMenu = (trigger: HTMLElement): boolean =>
  trigger.getAttribute('aria-expanded') === 'true' || trigger.dataset['state'] === 'open';

/**
 * A trigger behind an open dialog: focus comes back to it for a moment as the menu that opened the dialog
 * closes, and a tip opened then is the newest layer, so it took the dialog's Escape.
 */
const behindADialog = (trigger: HTMLElement): boolean =>
  Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).some(
    (dialog) => !dialog.contains(trigger),
  );

const mayOpen = (trigger: HTMLElement | null): boolean =>
  trigger !== null && !opensAMenu(trigger) && !behindADialog(trigger);

interface TooltipProps {
  readonly content: string;
  /** The key that does the same thing, if there is one. */
  readonly shortcut?: string;
  /** The one element the tip describes; it must be focusable. */
  readonly children: React.ReactElement;
  /** Where the tip opens; beside a control on the window's edge, it opens inward. */
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
}

export const Tooltip = ({
  content,
  shortcut,
  children,
  side = 'top',
}: TooltipProps): React.JSX.Element => {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <RadixTooltip.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next && mayOpen(trigger.current));
      }}
    >
      <RadixTooltip.Trigger
        ref={trigger}
        asChild
        // A press closes the tip, as Radix's own close would, but whatever the trigger did with it: a menu's
        // trigger cancels the press it opens on, Radix then skips its close, and the tip stayed over the menu.
        onPointerDown={() => {
          setOpen(false);
        }}
      >
        {children}
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          className={contentClasses}
          side={side}
          sideOffset={4}
          collisionPadding={8}
        >
          {content}
          {shortcut === undefined ? null : <Kbd>{shortcut}</Kbd>}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
};
