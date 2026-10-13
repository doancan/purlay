import { describe, expect, test } from 'bun:test';
import { act, render } from '@testing-library/react';
import { installDom } from './dom';
import { expectFocusOn } from './focus';

installDom();

describe('expectFocusOn', () => {
  test('passes on the focused element itself', () => {
    const view = render(
      <div>
        <button type="button">first</button>
        <button type="button">second</button>
      </div>,
    );
    const first = view.getByRole('button', { name: 'first' });
    act(() => {
      first.focus();
    });
    expectFocusOn(first);
    view.unmount();
  });

  test('fails on another element, however alike, and names both', () => {
    const view = render(
      <div>
        <button type="button">first</button>
        <button type="button">second</button>
      </div>,
    );
    act(() => {
      view.getByRole('button', { name: 'first' }).focus();
    });
    expect(() => {
      expectFocusOn(view.getByRole('button', { name: 'second' }));
    }).toThrow('focus is on <button> "first", not on <button> "second"');
    view.unmount();
  });

  test('fails when nothing it names has focus', () => {
    const view = render(<input aria-label="name" />);
    expect(() => {
      expectFocusOn(null);
    }).toThrow('not on nothing');
    view.unmount();
  });
});
