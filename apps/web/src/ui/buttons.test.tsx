/**
 * Buttons, keys and badges: what they say to assistive technology, and that the
 * accessibility audit passes with every variant on the page at once.
 */
import { installDom } from '../testing/dom';
import { describe, expect, mock, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import { expectNoAxeViolations } from '../testing/axe';
import { renderApp } from '../testing/render';
import { Badge } from './badge';
import { Button } from './button';
import { cn } from './cn';
import { IconButton } from './icon-button';
import { Kbd } from './kbd';

installDom();

describe('cn', () => {
  test('keeps strings and drops everything that is not one', () => {
    expect(cn('a', false, null, undefined, '', 'b')).toBe('a b');
  });
});

describe('Button', () => {
  test('is a button that does not submit a form unless it says so', async () => {
    const { getByRole } = await renderApp(<Button>Save</Button>);
    expect(getByRole('button', { name: 'Save' }).getAttribute('type')).toBe('button');
  });

  test('says so when it is a submit button', async () => {
    const { getByRole } = await renderApp(<Button type="submit">Save</Button>);
    expect(getByRole('button').getAttribute('type')).toBe('submit');
  });

  test('calls its handler, and does not when disabled', async () => {
    const onClick = mock(() => undefined);
    const { getByRole, rerender } = await renderApp(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} disabled>
        Go
      </Button>,
    );
    fireEvent.click(getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('busy is disabled and says so, and keeps its label', async () => {
    const { getByRole } = await renderApp(<Button busy>Send</Button>);
    const button = getByRole('button', { name: 'Send' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  test('an idle button is not marked busy at all', async () => {
    const { getByRole } = await renderApp(<Button>Send</Button>);
    expect(getByRole('button').hasAttribute('aria-busy')).toBe(false);
  });

  test('a glyph is decoration: the label is the name', async () => {
    const { getByRole } = await renderApp(<Button glyph="add">New channel</Button>);
    const button = getByRole('button', { name: 'New channel' });
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  test('each variant wears its own look, and takes a class from the caller', async () => {
    const { getByRole } = await renderApp(
      <div>
        <Button variant="primary">p</Button>
        <Button variant="secondary">s</Button>
        <Button variant="ghost">g</Button>
        <Button variant="danger" className="w-sidebar">
          d
        </Button>
        <Button variant="dangerQuiet">q</Button>
      </div>,
    );
    expect(getByRole('button', { name: 'q' }).className).toContain('bg-danger-subtle');
    expect(getByRole('button', { name: 'p' }).className).toContain('bg-accent');
    expect(getByRole('button', { name: 's' }).className).toContain('shadow-card');
    expect(getByRole('button', { name: 'g' }).className).toContain('border-transparent');
    expect(getByRole('button', { name: 'd' }).className).toContain('bg-danger');
    expect(getByRole('button', { name: 'd' }).className).toContain('w-sidebar');
  });

  test('passes the accessibility audit in every state', async () => {
    const { container } = await renderApp(
      <div>
        <Button variant="primary" glyph="add">
          Create
        </Button>
        <Button>Cancel</Button>
        <Button variant="ghost">More</Button>
        <Button variant="danger">Delete</Button>
        <Button variant="dangerQuiet">Leave</Button>
        <Button disabled>Disabled</Button>
        <Button busy>Busy</Button>
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('IconButton', () => {
  test('its name is its label, and the glyph is decoration', async () => {
    const { getByRole } = await renderApp(<IconButton label="Close" glyph="close" />);
    const button = getByRole('button', { name: 'Close' });
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(button.getAttribute('type')).toBe('button');
  });

  test('shows its label as a tooltip when it has focus', async () => {
    const { getByRole, findByRole } = await renderApp(
      <IconButton label="Close" glyph="close" shortcut="Esc" />,
    );
    act(() => {
      getByRole('button').focus();
    });
    const tip = await findByRole('tooltip');
    expect(tip.textContent).toContain('Close');
    expect(tip.textContent).toContain('Esc');
  });

  test('clicks, and is inert when disabled', async () => {
    const onClick = mock(() => undefined);
    const { getByRole } = await renderApp(
      <IconButton label="Copy" glyph="copy" onClick={onClick} disabled />,
    );
    fireEvent.click(getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  test('the type refuses an icon button with no name', () => {
    const refused = (): void => {
      // @ts-expect-error -- an icon-only control must say what it is (#138)
      <IconButton glyph="close" />;
    };
    expect(typeof refused).toBe('function');
  });

  test('passes the accessibility audit', async () => {
    const { container } = await renderApp(
      <div>
        <IconButton label="Close" glyph="close" />
        <IconButton label="Search" glyph="search" shortcut="⌘K" />
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('Kbd', () => {
  test('is a <kbd>, so a screen reader knows it is a key', async () => {
    const { container } = await renderApp(<Kbd>⌘K</Kbd>);
    expect(container.querySelector('kbd')?.textContent).toBe('⌘K');
  });
});

describe('Badge', () => {
  test('says what the number means, and not the number twice', async () => {
    const { getByRole } = await renderApp(<Badge count={2} label="2 unread mentions" />);
    const badge = getByRole('img', { name: '2 unread mentions' });
    expect(badge.textContent).toBe('2');
    expect(badge.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  test('passes the accessibility audit', async () => {
    const { container } = await renderApp(<Badge count={12} label="12 unread mentions" />);
    await expectNoAxeViolations(container);
  });
});
