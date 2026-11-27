/**
 * A settings row (D-146): how its label sits beside the control — centred on it when the label is
 * alone, hung from the top when a description runs under it — and stacked on a phone, except a check
 * box, which stays beside its label.
 */
import { describe, expect, test } from 'bun:test';
import { render } from '@testing-library/react';
import { installDom } from '../../testing/dom';
import { SettingsRow } from './page';

installDom();

const rowOf = (label: string, description?: string, toggle = false): string[] => {
  const view = render(
    <SettingsRow
      label={label}
      toggle={toggle}
      {...(description === undefined ? {} : { description })}
    >
      <button type="button">Do it</button>
    </SettingsRow>,
  );
  const classes = view.getByText(label).parentElement?.parentElement?.className.split(' ') ?? [];
  view.unmount();
  return classes;
};

describe('a settings row', () => {
  test('with a label alone, centres it on the control; on a phone it is stacked from the left', () => {
    const classes = rowOf('Invitation link');
    expect(classes).toContain('items-center');
    expect(classes).toContain('max-narrow:items-start');
  });

  test('with a description, hangs both from the top beside the control', () => {
    const classes = rowOf('This device', 'Sign out of Purlay in this browser only.');
    expect(classes).toContain('items-start');
    expect(classes).not.toContain('items-center');
  });

  test('stacks on a phone, label over control', () => {
    expect(rowOf('Keep history')).toContain('max-narrow:flex-col');
  });

  test('with a check box, keeps it beside the label on a phone too', () => {
    const classes = rowOf('Require an authenticator', undefined, true);
    expect(classes).not.toContain('max-narrow:flex-col');
    expect(classes).toContain('items-center');
    expect(classes).not.toContain('max-narrow:items-start');
  });
});
