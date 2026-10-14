/**
 * A dialog: the one place the product asks for a person's whole attention.
 *
 * `UX.md` §1 forbids a modal that hides the conversation — and that is about
 * *reading*; a form that has to be filled in (a new channel's name) or a list that
 * has to be read (the shortcuts) is the one thing on screen while it is open, and
 * Radix gives what that needs and what hand-written code forgets: focus moves in,
 * Tab stays in, Escape and a click outside close it, focus returns to whatever
 * opened it, and the rest of the page is hidden from a screen reader.
 *
 * **Title and description are required by the type.** A dialog with no accessible
 * name is announced as nothing; one with no description leaves a screen-reader
 * user to find out what it is for by exploring it. The scrim is `bg-scrim`, which
 * is translucent, so the conversation behind it is dimmed and still there.
 *
 * **Focus goes back to whatever opened it.** Radix returns focus to its own
 * `Dialog.Trigger`, and this dialog is controlled — the opener is somebody else's
 * button — so with no trigger Radix cancels the default return and has nowhere to
 * send focus: it lands on `<body>` and a keyboard user starts again from the top
 * of the page. (Found by the test below, not by reading.) The element that had
 * focus when the dialog opened is remembered and given focus again on close.
 *
 * Controlled (`open`/`onOpenChange`): who opens a dialog is the caller's business,
 * and a caller that owns the open state can also close it when a request succeeds.
 */
import * as RadixDialog from '@radix-ui/react-dialog';
import { useRef } from 'react';
import { IconButton } from './icon-button';

const overlayClasses = 'fixed inset-0 z-palette bg-scrim';

/**
 * The window's column the dialog sits in: the margins above and below it, and nothing to catch a
 * pointer, so a click beside the dialog is a click on the scrim, as it was.
 */
const contentClasses =
  'pointer-events-none fixed inset-x-4 inset-y-8 z-palette mx-auto flex max-w-dialog flex-col';

/**
 * The dialog itself: as tall as what it holds and never taller than the column, scrolling inside —
 * a long dialog's last button is never below the window, where nothing could reach it.
 */
const panelClasses =
  'pointer-events-auto relative flex min-h-0 flex-col gap-4 overflow-y-auto rounded-2xl border-hairline border-border-subtle bg-surface-100 p-6 text-ink shadow-float';

interface DialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  /** The close button's name, in the interface's language. */
  readonly closeLabel: string;
  readonly children: React.ReactNode;
  /** Buttons, right-aligned: the primary action last. */
  readonly footer?: React.ReactNode;
}

/**
 * Where focus goes back to when a dialog closes: what opened it — or, for an item of a menu, the
 * menu's own button. A menu item is gone by the time the dialog closes (the menu closed as it
 * opened the dialog), and focus sent to a node that is gone falls to the page (`expectFocusOn`
 * caught it, #506). Radix labels a menu by its trigger, so the button is found from the menu.
 */
const openerOf = (active: Element | null): HTMLElement | null => {
  if (!(active instanceof HTMLElement)) return null;
  const trigger = active.closest('[role="menu"]')?.getAttribute('aria-labelledby');
  const button = trigger == null ? null : document.getElementById(trigger);
  // A trigger that is itself gone (a submenu's item) is no better than the item: nothing, then, and
  // Radix's own return is left to stand.
  const opener = button ?? active;
  return opener.isConnected ? opener : null;
};

export const Dialog = ({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  children,
  footer,
}: DialogProps): React.JSX.Element => {
  const returnTo = useRef<HTMLElement | null>(null);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={overlayClasses} />
        <RadixDialog.Content
          className={contentClasses}
          onOpenAutoFocus={() => {
            // Fired before Radix moves focus in, so the active element is still the opener.
            returnTo.current = openerOf(document.activeElement);
          }}
          onCloseAutoFocus={(event) => {
            // Ours when we know where; Radix's own return otherwise, rather than nowhere.
            if (returnTo.current?.isConnected !== true) return;
            event.preventDefault();
            returnTo.current.focus();
          }}
        >
          <div className={panelClasses}>
            <div className="flex flex-col gap-1 pr-6">
              <RadixDialog.Title className="text-title text-ink">{title}</RadixDialog.Title>
              <RadixDialog.Description className="text-body text-ink-muted">
                {description}
              </RadixDialog.Description>
            </div>
            {children}
            {footer === undefined ? null : <div className="flex justify-end gap-2">{footer}</div>}
            {/* Last in the tree, first in the corner: Radix focuses the first focusable
            thing, and that should be the form, not a close button whose tooltip then
            takes the first Escape. */}
            <RadixDialog.Close asChild>
              <IconButton label={closeLabel} glyph="close" className="absolute right-3 top-3" />
            </RadixDialog.Close>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
};
