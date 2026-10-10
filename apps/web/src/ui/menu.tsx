/**
 * A menu — the workspace switcher, the account menu, the theme and language
 * pickers.
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
import { Icon, type GlyphName } from '../components/icon';
import { cn } from './cn';
import { Kbd } from './kbd';

const contentClasses =
  'z-popover min-w-members rounded-lg border-hairline border-border-subtle bg-surface-100 p-1 shadow-float';

const itemClasses =
  'flex h-control max-narrow:h-touch cursor-pointer items-center gap-2 rounded-md px-2 text-body text-ink data-[highlighted]:bg-surface-200 data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-muted';

const toneClasses = {
  default: '',
  danger: 'text-danger-text',
} as const;

interface MenuProps {
  /** The element that opens it: a button, which Radix gives the menu's ARIA to. */
  readonly trigger: React.ReactElement;
  readonly align?: 'start' | 'center' | 'end';
  readonly children: React.ReactNode;
}

export const Menu = ({ trigger, align = 'start', children }: MenuProps): React.JSX.Element => (
  <RadixMenu.Root>
    <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
    <RadixMenu.Portal>
      <RadixMenu.Content
        className={contentClasses}
        align={align}
        sideOffset={4}
        collisionPadding={8}
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
  readonly children: React.ReactNode;
}

/** One choice of several. The check is the *selected* signal; colour alone is never one. */
export const MenuRadioItem = ({
  value,
  glyph,
  children,
}: MenuRadioItemProps): React.JSX.Element => (
  <RadixMenu.RadioItem value={value} className={itemClasses}>
    {glyph === undefined ? null : <Icon name={glyph} />}
    <span className="flex-1">{children}</span>
    <RadixMenu.ItemIndicator>
      <Icon name="confirm" />
    </RadixMenu.ItemIndicator>
  </RadixMenu.RadioItem>
);
