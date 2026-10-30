/**
 * A menu — the workspace switcher, the account menu, the theme and language
 * pickers, and a sidebar row's context menu.
 *
 * Radix's dropdown does the keyboard model a menu has to have and a hand-written
 * one never quite does: Enter, Space or ArrowDown opens it; arrows move; typing a
 * letter jumps to the item that starts with it; Home and End; Escape closes and
 * returns focus to the trigger. Items are `role="menuitem"` and radio items are
 * `role="menuitemradio"` with `aria-checked`, which is how a screen reader says
 * "Light, selected".
 *
 * A highlighted item is `bg-surface-200`; the global focus ring still shows on
 * keyboard focus, because a menu is exactly where somebody needs to see where
 * they are.
 */
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { createPortal } from 'react-dom';
import { Icon, type GlyphName } from '../components/icon';
import { cn } from './cn';
import { Kbd } from './kbd';
import { VisuallyHidden } from './visually-hidden';

// Grows out of the control it opened from, and leaves a little faster (D-211).
const contentClasses =
  'z-popover min-w-sidebar rounded-2xl border-hairline border-border-subtle bg-surface-100 p-1 shadow-float data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out';

const itemClasses =
  'flex h-control max-narrow:h-touch cursor-pointer items-center gap-2 rounded-md px-2 text-body data-[highlighted]:bg-surface-200 data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-muted';

// Whole, never one over the other: `cn` does not merge, and in the stylesheet `text-ink` came after.
const toneClasses = {
  default: 'text-ink',
  danger: 'text-danger-text',
} as const;

interface MenuProps {
  /** The element that opens it: a button, which Radix gives the menu's ARIA to. */
  readonly trigger: React.ReactElement;
  readonly align?: 'start' | 'center' | 'end';
  /** Where it opens; from the rail, to the right. */
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
  readonly children: React.ReactNode;
  /** Whether focus returns to the trigger on close: not when the item chosen put it elsewhere. */
  readonly returnFocus?: () => boolean;
  /** Told when it opens and closes: a message's bar stays drawn while its menu is open. */
  readonly onOpenChange?: (open: boolean) => void;
  /** What it must stay inside besides the window: a feed, so it never covers the composer below. */
  readonly boundary?: Element | null;
}

export const Menu = ({
  trigger,
  align = 'start',
  side = 'bottom',
  children,
  returnFocus,
  onOpenChange,
  boundary,
}: MenuProps): React.JSX.Element => (
  <RadixMenu.Root {...(onOpenChange === undefined ? {} : { onOpenChange })}>
    <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
    <RadixMenu.Portal>
      <RadixMenu.Content
        className={contentClasses}
        align={align}
        side={side}
        sideOffset={4}
        collisionPadding={8}
        {...(boundary == null ? {} : { collisionBoundary: boundary })}
        onCloseAutoFocus={(event) => {
          if (returnFocus?.() === false) event.preventDefault();
        }}
      >
        {children}
      </RadixMenu.Content>
    </RadixMenu.Portal>
  </RadixMenu.Root>
);

/** The box an anchored menu opens from, in the window's coordinates: a point has no size. */
export interface MenuAnchor {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface AnchoredMenuProps {
  /** Where it opens, while it is open; null is closed. */
  readonly anchor: MenuAnchor | null;
  /** What it is for, said as its name: a menu with no button has nothing else to be named by. */
  readonly label: string;
  readonly onClose: () => void;
  /** Where focus goes once it has closed: there is no button for Radix to give it back to. */
  readonly onClosed: () => void;
  readonly children: React.ReactNode;
}

/**
 * A menu with no button: a context menu, opened at the pointer, at a finger's long press, or under a
 * row the keyboard is on (D-165). The same Radix menu as the rest, so its items, its keys and its look
 * are theirs; what it opens from is a box of no appearance at `anchor`, drawn on the page's body so a
 * transformed ancestor (the narrow sidebar's overlay) cannot move it.
 */
export const AnchoredMenu = ({
  anchor,
  label,
  onClose,
  onClosed,
  children,
}: AnchoredMenuProps): React.JSX.Element => (
  <RadixMenu.Root
    open={anchor !== null}
    onOpenChange={(open) => {
      if (!open) onClose();
    }}
  >
    {createPortal(
      <RadixMenu.Trigger asChild>
        <span
          aria-hidden="true"
          className="pointer-events-none fixed"
          style={
            anchor === null
              ? {}
              : { left: anchor.x, top: anchor.y, width: anchor.width, height: anchor.height }
          }
        >
          {/* The menu is labelled by its trigger (Radix): this is the name a screen reader says. */}
          <VisuallyHidden>{label}</VisuallyHidden>
        </span>
      </RadixMenu.Trigger>,
      document.body,
    )}
    <RadixMenu.Portal>
      <RadixMenu.Content
        className={contentClasses}
        align="start"
        side="bottom"
        sideOffset={4}
        collisionPadding={8}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        {children}
      </RadixMenu.Content>
    </RadixMenu.Portal>
  </RadixMenu.Root>
);

interface MenuItemProps {
  readonly onSelect: () => void;
  readonly glyph?: GlyphName;
  readonly shortcut?: string;
  readonly tone?: keyof typeof toneClasses;
  readonly disabled?: boolean;
  readonly children: React.ReactNode;
}

export const MenuItem = ({
  onSelect,
  glyph,
  shortcut,
  tone = 'default',
  disabled = false,
  children,
}: MenuItemProps): React.JSX.Element => (
  <RadixMenu.Item
    className={cn(itemClasses, toneClasses[tone])}
    onSelect={onSelect}
    disabled={disabled}
  >
    {glyph === undefined ? null : <Icon name={glyph} />}
    <span className="flex-1">{children}</span>
    {shortcut === undefined ? null : <Kbd>{shortcut}</Kbd>}
  </RadixMenu.Item>
);

interface MenuSubProps {
  readonly glyph?: GlyphName;
  /** What the item that opens it says; a chevron after it says there is more. */
  readonly label: string;
  readonly children: React.ReactNode;
}

/**
 * A menu inside a menu: a group of choices that would crowd the menu it opens from, as a
 * submenu does in every desktop app. ArrowRight or Enter opens it and ArrowLeft closes it,
 * which is Radix's; the item stays highlighted while its submenu is open, so the eye can
 * follow where it came from.
 */
export const MenuSub = ({ glyph, label, children }: MenuSubProps): React.JSX.Element => (
  <RadixMenu.Sub>
    <RadixMenu.SubTrigger
      className={cn(itemClasses, toneClasses.default, 'data-[state=open]:bg-surface-200')}
    >
      {glyph === undefined ? null : <Icon name={glyph} />}
      <span className="flex-1">{label}</span>
      <span className="text-ink-subtle">
        <Icon name="next" />
      </span>
    </RadixMenu.SubTrigger>
    <RadixMenu.Portal>
      <RadixMenu.SubContent className={contentClasses} sideOffset={4} collisionPadding={8}>
        {children}
      </RadixMenu.SubContent>
    </RadixMenu.Portal>
  </RadixMenu.Sub>
);

export const MenuLabel = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <RadixMenu.Label className="px-2 py-1 text-label text-ink-muted">{children}</RadixMenu.Label>
);

export const MenuSeparator = (): React.JSX.Element => (
  <RadixMenu.Separator className="my-1 border-t-hairline border-border-subtle" />
);

interface MenuRadioGroupProps {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly children: React.ReactNode;
}

export const MenuRadioGroup = ({
  value,
  onValueChange,
  children,
}: MenuRadioGroupProps): React.JSX.Element => (
  <RadixMenu.RadioGroup value={value} onValueChange={onValueChange}>
    {children}
  </RadixMenu.RadioGroup>
);

interface MenuRadioItemProps {
  readonly value: string;
  readonly glyph?: GlyphName;
  /**
   * Drawn before the words in place of a glyph — a person's avatar. Its letters are not the item's:
   * typing jumps by `textValue`, so it is required with one.
   */
  readonly leading?: { readonly node: React.ReactNode; readonly textValue: string };
  readonly children: React.ReactNode;
}

/** One choice of several. The check is the *selected* signal; colour alone is never one. */
export const MenuRadioItem = ({
  value,
  glyph,
  leading,
  children,
}: MenuRadioItemProps): React.JSX.Element => (
  <RadixMenu.RadioItem
    value={value}
    className={cn(itemClasses, toneClasses.default)}
    {...(leading === undefined ? {} : { textValue: leading.textValue })}
  >
    {leading?.node}
    {glyph === undefined ? null : <Icon name={glyph} />}
    <span className="flex-1">{children}</span>
    <RadixMenu.ItemIndicator>
      <Icon name="confirm" />
    </RadixMenu.ItemIndicator>
  </RadixMenu.RadioItem>
);

interface MenuCheckboxItemProps {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly children: React.ReactNode;
}

/**
 * A switch among several that are set together: it says *on* with a check (`aria-checked`, never only a tint) and
 * leaves the menu open, so a few can be set without opening it again. A choice of one among several is
 * `MenuRadioItem`, which closes it.
 */
export const MenuCheckboxItem = ({
  checked,
  onCheckedChange,
  children,
}: MenuCheckboxItemProps): React.JSX.Element => (
  <RadixMenu.CheckboxItem
    checked={checked}
    onCheckedChange={onCheckedChange}
    onSelect={(event) => {
      event.preventDefault();
    }}
    className={cn(itemClasses, toneClasses.default)}
  >
    <span className="flex-1">{children}</span>
    <RadixMenu.ItemIndicator>
      <Icon name="confirm" />
    </RadixMenu.ItemIndicator>
  </RadixMenu.CheckboxItem>
);

/**
 * A row of square choices that are glyphs rather than words — the quick reactions. Each is a
 * checkbox item, so one already chosen says so (`aria-checked`) and not only by its tint, and the
 * arrows along the row move along it as the arrows down a list do.
 */
export const MenuTiles = ({
  children,
  grid = false,
}: {
  readonly children: React.ReactNode;
  /**
   * Eight to a row instead of one long row, and ↑ ↓ move a row (D-181): an emoji picker is a grid, and a
   * grid that only the sideways arrows can cross is a list in disguise. Radix's own ↑ ↓ would step one.
   */
  readonly grid?: boolean;
}): React.JSX.Element => (
  <div
    role="group"
    className={grid ? 'grid grid-cols-8 gap-1' : 'flex gap-1'}
    onKeyDown={(event) => {
      const step =
        event.key === 'ArrowRight'
          ? 1
          : event.key === 'ArrowLeft'
            ? -1
            : grid && event.key === 'ArrowDown'
              ? GRID_COLUMNS
              : grid && event.key === 'ArrowUp'
                ? -GRID_COLUMNS
                : 0;
      if (step === 0) return;
      const tiles = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
      );
      const at = tiles.findIndex((tile) => tile === document.activeElement);
      const to = at + step;
      // Sideways wraps round the whole group; a row up from the first or down from the last stays put,
      // for Radix to carry on to what is above or below the grid.
      if (Math.abs(step) === GRID_COLUMNS && (to < 0 || to >= tiles.length)) return;
      tiles[(to + tiles.length) % tiles.length]?.focus();
      event.preventDefault();
      event.stopPropagation();
    }}
  >
    {children}
  </div>
);

/** How many tiles a grid has in a row. */
const GRID_COLUMNS = 8;

interface MenuTileProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onSelect: () => void;
  /** Told when it is reached, by the pointer or the keyboard. */
  readonly onHighlight?: () => void;
  /**
   * As wide as the cell it is in, square, instead of a fixed height: a grid of eight on a phone is
   * narrower than eight finger-tall tiles (the picker ran off the screen's edge).
   */
  readonly fill?: boolean;
  readonly children: React.ReactNode;
}

export const MenuTile = ({
  label,
  checked,
  onSelect,
  onHighlight,
  fill = false,
  children,
}: MenuTileProps): React.JSX.Element => (
  <RadixMenu.CheckboxItem
    aria-label={label}
    checked={checked}
    onSelect={onSelect}
    {...(onHighlight === undefined ? {} : { onFocus: onHighlight })}
    className={cn(
      'flex aspect-square cursor-pointer items-center justify-center rounded-md text-title data-[highlighted]:bg-surface-200 data-[state=checked]:bg-accent-subtle',
      fill ? 'w-full' : 'h-row max-narrow:h-touch',
    )}
  >
    <span aria-hidden="true">{children}</span>
  </RadixMenu.CheckboxItem>
);
