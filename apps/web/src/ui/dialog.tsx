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
import { cn } from './cn';
import { IconButton } from './icon-button';

/**
 * The scrim, and what scrolls when a dialog is taller than the window (Radix's scrollable overlay): the
 * dialog sits inside it, a margin from the top and the bottom, so its last button is reached by
 * scrolling rather than lost below the window. A click on it beside the dialog closes the dialog.
 */
const overlayClasses = 'fixed inset-0 z-palette overflow-y-auto bg-scrim';

const contentClasses = 'relative mx-auto flex flex-col gap-4 bg-surface-100 text-ink outline-none';

/**
 * The two widths (D-154). A dialog is 480px, a margin inside the window on a phone. A **wide** one —
 * a surface with tabs, such as a channel's details — is 640px, and below the narrow width it is a
 * sheet that fills the screen: a phone has no room for a card's margins around a whole surface.
 * Each size's classes are whole, never one overriding the other (`cn` does not merge them).
 */
const sizeClasses = {
  default: {
    overlay: 'px-4 py-8',
    content: 'max-w-dialog rounded-2xl border-hairline border-border-subtle p-6 shadow-float',
  },
  wide: {
    overlay: 'narrow:px-4 narrow:py-8',
    content:
      'max-w-dialog-lg p-6 max-narrow:min-h-full max-narrow:p-4 narrow:rounded-2xl narrow:border-hairline narrow:border-border-subtle narrow:shadow-float',
  },
} as const;

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
  /**
   * What takes the first focus: the first control (a form to fill in), or the dialog itself — one
   * to read before anything in it is changed, whose first field holds something already there (a
   * channel's name, D-123). Either way no text is ever selected on opening.
   */
  readonly focusFirst?: 'control' | 'dialog';
  /** `wide` for a surface with tabs (D-154); a dialog is the default width. */
  readonly size?: keyof typeof sizeClasses;
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

/**
 * What Radix would focus first: the first control a Tab would reach, in the tree's order — never a
 * link, which Radix's first focus skips (`removeLinks` in its focus scope).
 */
const firstControl = (root: HTMLElement): Element | null =>
  [...root.querySelectorAll(CONTROLS)].find(
    (element) => element instanceof HTMLElement && element.tabIndex >= 0 && !element.hidden,
  ) ?? null;

const CONTROLS =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not(a)';

export const Dialog = ({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  children,
  footer,
  focusFirst = 'control',
  size = 'default',
}: DialogProps): React.JSX.Element => {
  const returnTo = useRef<HTMLElement | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={cn(overlayClasses, sizeClasses[size].overlay)}>
          <RadixDialog.Content
            className={cn(contentClasses, sizeClasses[size].content)}
            onOpenAutoFocus={(event) => {
              // Fired before Radix moves focus in, so the active element is still the opener.
              returnTo.current = openerOf(document.activeElement);
              // A dialog with nothing to fill in (a list to read) would give its first focus to
              // the close button, whose tooltip then takes the first Escape (#623): the dialog
              // itself takes it instead, and Tab still reaches Close.
              const content = event.currentTarget;
              if (!(content instanceof HTMLElement)) return;
              const first = firstControl(content);
              if (focusFirst === 'dialog' || first === close.current) {
                event.preventDefault();
                content.focus();
              } else if (
                (first instanceof HTMLInputElement || first instanceof HTMLTextAreaElement) &&
                first.value !== '' &&
                // An email or a number field has no selection to set (it would throw).
                first.selectionStart !== null
              ) {
                // Radix selects the text of the field it focuses, so the first key typed would
                // replace what is there: the caret goes to its end instead.
                event.preventDefault();
                first.focus();
                first.setSelectionRange(first.value.length, first.value.length);
              }
            }}
            onCloseAutoFocus={(event) => {
              // Ours when we know where; Radix's own return otherwise, rather than nowhere.
              if (returnTo.current?.isConnected !== true) return;
              event.preventDefault();
              returnTo.current.focus();
            }}
          >
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
              <IconButton
                ref={close}
                label={closeLabel}
                glyph="close"
                className="absolute right-3 top-3"
              />
            </RadixDialog.Close>
          </RadixDialog.Content>
        </RadixDialog.Overlay>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
};
