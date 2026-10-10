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
import { Menu, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator } from './menu';
import { Tooltip } from './tooltip';

installDom();

describe('Tooltip', () => {
  test('opens on keyboard focus, names itself, and shows the shortcut', async () => {
    const { getByRole, findByRole } = await renderApp(
      <Tooltip content="Search" shortcut="⌘K">
        <button type="button">s</button>
      </Tooltip>,
    );
    act(() => {
      getByRole('button').focus();
    });
    const tip = await findByRole('tooltip');
    expect(tip.textContent).toContain('Search');
    expect(tip.textContent).toContain('⌘K');
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
      expect(document.activeElement === opener).toBe(true);
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
      <MenuItem onSelect={onSelect} glyph="sign-out" shortcut="⇧⌘Q">
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
      'Sign out⇧⌘Q',
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
      expect(document.activeElement === trigger).toBe(true);
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
