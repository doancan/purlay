/**
 * The check box and the radio button: the browser's own inputs, drawn in the product's tokens — so the
 * keyboard, the label, the form and the screen reader are the platform's, and the look is ours in both themes.
 */
import { installDom } from '../testing/dom';
import { describe, expect, mock, test } from 'bun:test';
import { fireEvent } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expectNoAxeViolations } from '../testing/axe';
import { renderApp } from '../testing/render';
import { Checkbox, Radio } from './checkbox';

installDom();

describe('Checkbox', () => {
  test('is a native check box, named by the label that wraps it, and tells its handler what it became', async () => {
    const onChange = mock<(checked: boolean) => void>(() => undefined);
    const { getByRole } = await renderApp(
      <label>
        <Checkbox
          checked={false}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        Private
      </label>,
    );
    const box = getByRole('checkbox', { name: 'Private' });
    expect(box.tagName).toBe('INPUT');
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  test('draws its tick for a checked box only, and keeps it out of the accessibility tree', async () => {
    const { container, rerender } = await renderApp(
      <label>
        <Checkbox checked readOnly />
        On
      </label>,
    );
    const tick = container.querySelector('svg');
    expect(tick?.getAttribute('aria-hidden')).toBe('true');
    // Shown by the input's state alone: the class that reveals it follows `:checked`, not a prop.
    expect(tick?.parentElement?.getAttribute('class')).toContain('peer-checked:opacity-100');
    rerender(
      <label>
        <Checkbox checked={false} readOnly />
        On
      </label>,
    );
    expect(container.querySelector('input')?.checked).toBe(false);
  });

  test('does not change when disabled, and says so', async () => {
    const onChange = mock(() => undefined);
    const { getByRole } = await renderApp(
      <label>
        <Checkbox checked={false} disabled onChange={onChange} />
        Locked
      </label>,
    );
    const box = getByRole('checkbox', { name: 'Locked' });
    expect(box.hasAttribute('disabled')).toBe(true);
    fireEvent.click(box);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('keeps the description a caller points at, and passes the audit', async () => {
    const { getByRole, container } = await renderApp(
      <div>
        <label>
          <Checkbox checked={false} readOnly aria-describedby="why" />
          Private
        </label>
        <p id="why">Only the people inside see it.</p>
      </div>,
    );
    expect(getByRole('checkbox').getAttribute('aria-describedby')).toBe('why');
    await expectNoAxeViolations(container);
  });
});

describe('Radio', () => {
  test('is a native radio in a group, one chosen at a time, named by its label', async () => {
    const { getByRole } = await renderApp(
      <fieldset>
        <legend>Theme</legend>
        <label>
          <Radio name="theme" value="light" defaultChecked />
          Light
        </label>
        <label>
          <Radio name="theme" value="dark" />
          Dark
        </label>
      </fieldset>,
    );
    const dark = getByRole('radio', { name: 'Dark' });
    expect(dark.tagName).toBe('INPUT');
    fireEvent.click(dark);
    expect((getByRole('radio', { name: 'Dark' }) as HTMLInputElement).checked).toBe(true);
    expect((getByRole('radio', { name: 'Light' }) as HTMLInputElement).checked).toBe(false);
  });
});

const sources = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.tsx') && !name.includes('.test.') ? [path] : [];
  });

describe('the screens', () => {
  test('draw no native check box or radio of their own: there is one, and it is this one (D-182)', () => {
    const own = sources(join(import.meta.dir, '..')).filter(
      (path) =>
        !path.endsWith('ui/checkbox.tsx') &&
        /type="(checkbox|radio)"/.test(readFileSync(path, 'utf8')),
    );
    expect(own).toEqual([]);
  });
});
