/**
 * Tooltip, dialog and menu — the three Radix primitives. What is asserted is what
 * Radix is *for*: the keyboard model, focus going in and coming back, the names
 * and roles a screen reader hears. Overlays render into a portal, outside the
 * test's container, so the accessibility audit runs on `baseElement`.
 */
import { installDom } from '../testing/dom';
import { describe, expect, mock, test } from 'bun:test';
import { act, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { expectNoAxeViolations } from '../testing/axe';
import { renderApp } from '../testing/render';
import { person } from '../testing/user';
import { Button } from './button';
import { Dialog } from './dialog';
import { IconButton } from './icon-button';
import {
  Menu,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  subPlacement,
} from './menu';
import { Tooltip } from './tooltip';
import { expectFocusOn } from '../testing/focus';

installDom();

describe('Tooltip', () => {
  test('opens on keyboard focus, names itself, and shows the shortcut', async () => {
    const { getByRole, findByRole } = await renderApp(
      <Tooltip content="Search" shortcut="Mod+K">
        <button type="button">s</button>
      </Tooltip>,
    );
    act(() => {
      getByRole('button').focus();
    });
    const tip = await findByRole('tooltip');
    expect(tip.textContent).toContain('Search');
    // Spelled for the test's keyboard, which is not a Mac's (`kbd.test.tsx` has both).
    expect(tip.textContent).toContain('Ctrl+K');
  });

  test('without a shortcut it shows only the content', async () => {
    const { getByRole, findByRole } = await renderApp(
      <Tooltip content="Search">
        <button type="button">s</button>
      </Tooltip>,
    );
    act(() => {
      getByRole('button').focus();
    });
    expect((await findByRole('tooltip')).textContent).toBe('Search');
  });

  test('Escape closes it', async () => {
    const { getByRole, findByRole, queryByRole } = await renderApp(
      <Tooltip content="Search">
        <button type="button">s</button>
      </Tooltip>,
    );
    act(() => {
      getByRole('button').focus();
    });
    await findByRole('tooltip');
    await person().keyboard('{Escape}');
    await waitFor(() => {
      expect(queryByRole('tooltip')).toBeNull();
    });
  });

  test.each([
    ['aria-expanded', 'true'],
    ['data-state', 'open'],
  ])('does not open over the menu its trigger has open (%s)', async (attribute, value) => {
    const { getByRole, queryByRole } = await renderApp(
      <Tooltip content="Options">
        <button type="button" {...{ [attribute]: value }}>
          o
        </button>
      </Tooltip>,
    );
    act(() => {
      getByRole('button').focus();
    });
    // Long enough for the tip to have opened, had it been going to.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queryByRole('tooltip')).toBeNull();
  });

  test('closes when its trigger is pressed to open a menu, though the menu takes the press', async () => {
    const { getByRole, findByRole, queryByRole } = await renderApp(
      <Menu trigger={<IconButton label="Options" glyph="preferences" />}>
        <MenuItem onSelect={() => undefined}>Only unread</MenuItem>
      </Menu>,
    );
    // Hovered, not focused: a press that opens a menu never focuses its trigger, so no blur closes the tip.
    const options = getByRole('button', { name: 'Options' });
    const pointer = person();
    await pointer.hover(options);
    await findByRole('tooltip', {}, { timeout: 1000 });
    // As a browser delivers it: not inside `act`, so the menu is open, a layer over the tip, before the press
    // reaches the document — where the tip would otherwise have heard it as a press outside itself.
    options.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerType: 'mouse',
      }),
    );
    await findByRole('menu');
    // `hidden`: an open menu hides the rest of the page from the accessibility tree, the tip with it.
    await waitFor(() => {
      expect(queryByRole('tooltip', { hidden: true })).toBeNull();
    });
  });
});

const Harness = ({
  onOpenChange,
}: {
  readonly onOpenChange?: (open: boolean) => void;
}): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        Open
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          onOpenChange?.(next);
          setOpen(next);
        }}
        title="New channel"
        description="Anyone in the workspace can join."
        closeLabel="Close"
        footer={<Button variant="primary">Create</Button>}
      >
        <input aria-label="Name" />
      </Dialog>
    </div>
  );
};

describe('Dialog', () => {
  test('is a dialog named by its title and described by its description', async () => {
    const { getByRole, queryByRole } = await renderApp(<Harness />);
    expect(queryByRole('dialog')).toBeNull();
    await person().click(getByRole('button', { name: 'Open' }));
    const dialog = getByRole('dialog', { name: 'New channel' });
    expect(dialog.getAttribute('aria-describedby')).not.toBeNull();
    expect(getByRole('heading', { name: 'New channel' })).toBeDefined();
    expect(dialog.textContent).toContain('Anyone in the workspace can join.');
  });

  test('moves focus in, and Escape closes it and gives focus back', async () => {
    const onOpenChange = mock(() => undefined);
    const { getByRole, queryByRole } = await renderApp(<Harness onOpenChange={onOpenChange} />);
    const opener = getByRole('button', { name: 'Open' });
    await person().click(opener);
    expect(getByRole('dialog').contains(document.activeElement)).toBe(true);
    await person().keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await waitFor(() => {
      expect(queryByRole('dialog')).toBeNull();
    });
    // Radix returns focus on the next tick; the comparison is a boolean so a miss
    // does not print the whole document.
    await waitFor(() => {
      expectFocusOn(opener);
    });
  });

  test('the close button closes it', async () => {
    const { getByRole, queryByRole } = await renderApp(<Harness />);
    await person().click(getByRole('button', { name: 'Open' }));
    await person().click(getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(queryByRole('dialog')).toBeNull();
    });
  });

  test('without a footer there is no footer', async () => {
    const { getByRole, queryByRole } = await renderApp(
      <Dialog open onOpenChange={() => undefined} title="T" description="D" closeLabel="Close">
        body
      </Dialog>,
    );
    expect(getByRole('dialog')).toBeDefined();
    expect(queryByRole('button', { name: 'Create' })).toBeNull();
  });

  test('with nothing but Close to focus, the first Escape closes it', async () => {
    // A read-only dialog (the audit log): Radix's first focus would be the close button, whose
    // tooltip opens on that focus and is the layer the first Escape closes (#623).
    const Reader = (): React.JSX.Element => {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <Button
            onClick={() => {
              setOpen(true);
            }}
          >
            Open
          </Button>
          <Dialog
            open={open}
            onOpenChange={setOpen}
            title="Audit log"
            description="Newest first."
            closeLabel="Close"
          >
            <p>Alice created #api</p>
          </Dialog>
        </div>
      );
    };
    const { getByRole, queryByRole } = await renderApp(<Reader />);
    await person().click(getByRole('button', { name: 'Open' }));
    const dialog = getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement === getByRole('button', { name: 'Close' })).toBe(false);
    expect(queryByRole('tooltip')).toBeNull();
    await person().keyboard('{Escape}');
    await waitFor(() => {
      expect(queryByRole('dialog')).toBeNull();
    });
  });

  test('a first field that already holds text is focused with nothing selected', async () => {
    // Radix selects the text of the field it focuses first, so one keystroke replaced it: a
    // channel's name, renamed by the first letter typed into its details.
    const { getByRole, getByLabelText } = await renderApp(
      <Dialog open onOpenChange={() => undefined} title="Rename" description="D" closeLabel="Close">
        <input aria-label="Name" defaultValue="general" />
      </Dialog>,
    );
    const field = getByLabelText('Name');
    if (!(field instanceof HTMLInputElement)) throw new Error('Name is not a field');
    await waitFor(() => {
      expect(getByRole('dialog').contains(document.activeElement)).toBe(true);
    });
    expectFocusOn(field);
    expect(field.selectionStart).toBe('general'.length);
    expect(field.selectionEnd).toBe('general'.length);
  });

  test('a dialog to read first takes the first focus itself, not its first field', async () => {
    const { getByRole, getByLabelText } = await renderApp(
      <Dialog
        open
        onOpenChange={() => undefined}
        title="Details"
        description="D"
        closeLabel="Close"
        focusFirst="dialog"
      >
        <input aria-label="Name" defaultValue="general" />
      </Dialog>,
    );
    await waitFor(() => {
      expect(getByRole('dialog').contains(document.activeElement)).toBe(true);
    });
    expectFocusOn(getByRole('dialog'));
    expect(document.activeElement === getByLabelText('Name')).toBe(false);
  });

  test('with only a link before Close, Close still does not take the first focus', async () => {
    // Radix never gives first focus to a link, so a dialog whose one other control is a link (an
    // export ready to download, its request button busy) would still focus Close.
    const { getByRole, queryByRole } = await renderApp(
      <Dialog open onOpenChange={() => undefined} title="Export" description="D" closeLabel="Close">
        <a href="/export.zip">export.zip</a>
      </Dialog>,
    );
    await waitFor(() => {
      expect(getByRole('dialog').contains(document.activeElement)).toBe(true);
    });
    expect(document.activeElement === getByRole('button', { name: 'Close' })).toBe(false);
    expect(queryByRole('tooltip')).toBeNull();
  });

  test('passes the accessibility audit', async () => {
    const { getByRole } = await renderApp(<Harness />);
    await person().click(getByRole('button', { name: 'Open' }));
    await expectNoAxeViolations(getByRole('dialog'));
  });
});

describe('Menu', () => {
  const Account = ({ onSelect }: { readonly onSelect: () => void }): React.JSX.Element => (
    <Menu trigger={<Button>Account</Button>}>
      <MenuLabel>alice</MenuLabel>
      <MenuItem onSelect={onSelect} glyph="sign-out" shortcut="Mod+Shift+Q">
        Sign out
      </MenuItem>
      <MenuItem onSelect={onSelect} tone="danger">
        Sign out everywhere
      </MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={onSelect} disabled>
        Unavailable
      </MenuItem>
    </Menu>
  );

  test('opens from the keyboard, and its items are menu items', async () => {
    const { getByRole, getAllByRole } = await renderApp(<Account onSelect={() => undefined} />);
    act(() => {
      getByRole('button', { name: 'Account' }).focus();
    });
    await person().keyboard('{Enter}');
    expect(getByRole('menu')).toBeDefined();
    expect(getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Sign outCtrl+Shift+Q',
      'Sign out everywhere',
      'Unavailable',
    ]);
  });

  test('arrows move, Enter chooses and closes', async () => {
    const onSelect = mock(() => undefined);
    const { getByRole, queryByRole } = await renderApp(<Account onSelect={onSelect} />);
    act(() => {
      getByRole('button', { name: 'Account' }).focus();
    });
    await person().keyboard('{Enter}');
    await person().keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(queryByRole('menu')).toBeNull();
    });
  });

  test('a disabled item cannot be chosen', async () => {
    const onSelect = mock(() => undefined);
    const { getByRole } = await renderApp(<Account onSelect={onSelect} />);
    await person().click(getByRole('button', { name: 'Account' }));
    expect(getByRole('menuitem', { name: 'Unavailable' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    await person().click(getByRole('menuitem', { name: 'Unavailable' }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('Escape closes it and returns focus to the trigger', async () => {
    const { getByRole, queryByRole } = await renderApp(<Account onSelect={() => undefined} />);
    const trigger = getByRole('button', { name: 'Account' });
    await person().click(trigger);
    await person().keyboard('{Escape}');
    await waitFor(() => {
      expect(queryByRole('menu')).toBeNull();
    });
    await waitFor(() => {
      expectFocusOn(trigger);
    });
  });

  test('radio items are one setting: the chosen one is checked', async () => {
    const onValueChange = mock<(value: string) => void>();
    const { getByRole, getAllByRole } = await renderApp(
      <Menu trigger={<Button>Theme</Button>}>
        <MenuRadioGroup value="light" onValueChange={onValueChange}>
          <MenuRadioItem value="system" glyph="system">
            System
          </MenuRadioItem>
          <MenuRadioItem value="light">Light</MenuRadioItem>
        </MenuRadioGroup>
      </Menu>,
    );
    await person().click(getByRole('button', { name: 'Theme' }));
    const radios = getAllByRole('menuitemradio');
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    await person().click(getByRole('menuitemradio', { name: 'System' }));
    expect(onValueChange).toHaveBeenCalledWith('system');
  });

  test('passes the accessibility audit', async () => {
    const { getByRole } = await renderApp(<Account onSelect={() => undefined} />);
    await person().click(getByRole('button', { name: 'Account' }));
    await expectNoAxeViolations(getByRole('menu'));
  });
});

describe('a tooltip under a dialog', () => {
  test('does not open for a trigger outside it, so the dialog keeps its Escape', async () => {
    const { getByRole, queryByRole } = await renderApp(
      <>
        <Tooltip content="More">
          <button type="button">m</button>
        </Tooltip>
        <div role="dialog" aria-label="Remind me" data-state="open">
          <Tooltip content="Inside">
            <button type="button">i</button>
          </Tooltip>
        </div>
      </>,
    );
    act(() => {
      getByRole('button', { name: 'm' }).focus();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queryByRole('tooltip')).toBeNull();
    // One inside the dialog still names its control.
    act(() => {
      getByRole('button', { name: 'i' }).focus();
    });
    await waitFor(() => {
      expect(queryByRole('tooltip')?.textContent).toBe('Inside');
    });
  });
});

describe('a submenu’s place', () => {
  const box = (left: number, width: number, height = 32): Parameters<typeof subPlacement>[0] => ({
    left,
    right: left + width,
    width,
    height,
  });

  test('is beside its menu where a menu’s width fits on a side', () => {
    expect(subPlacement(box(100, 264, 300), box(104, 256), 1280)).toEqual({
      sideOffset: 4,
      alignOffset: 0,
    });
    // At a wide window's right edge it fits on the left, where Radix flips it.
    expect(subPlacement(box(1008, 264, 300), box(1012, 256), 1280)).toEqual({
      sideOffset: 4,
      alignOffset: 0,
    });
  });

  test('on a phone it opens over its menu, just under the item that opened it', () => {
    expect(subPlacement(box(118, 264, 300), box(122, 256, 44), 390)).toEqual({
      sideOffset: -256,
      alignOffset: 44,
    });
  });
});
