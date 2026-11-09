/**
 * The setup screen's copy button (`CopyField`). It can be served over plain http, where
 * `navigator.clipboard` is absent: pressing Copy must leave the button as it was, not throw.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { installDom } from '../../testing/dom';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { CopyField } from './parts';

installDom();

const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  if (clipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard');
  else Object.defineProperty(navigator, 'clipboard', clipboard);
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('the copy button beside a value', () => {
  test('says Copied once the clipboard has it', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (): Promise<void> => Promise.resolve() },
    });
    const view = await renderApp(<CopyField label="Address" value="purlay.test" />);
    await person().click(view.getByRole('button', { name: 'Copy' }));
    await settle();
    expect(view.getByRole('button', { name: 'Copied' })).toBeDefined();
    view.unmount();
  });

  test('with no clipboard in the browser it stays Copy, and nothing is thrown', async () => {
    // `user-event` puts a clipboard of its own on the page when it is set up: set up first, then take it away.
    const user = person();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const view = await renderApp(<CopyField label="Address" value="purlay.test" />);
    await user.click(view.getByRole('button', { name: 'Copy' }));
    await settle();
    expect(view.getByRole('button', { name: 'Copy' })).toBeDefined();
    view.unmount();
  });
});
