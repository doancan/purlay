import { afterEach, describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { installDom } from '../../testing/dom';
import { renderApp } from '../../testing/render';
import { movementClass, useReducedMotion } from './motion';

installDom();

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
});

const Probe = (): React.JSX.Element => <p>{useReducedMotion() ? 'still' : 'moving'}</p>;

describe('the wizard’s motion', () => {
  test('plays a movement’s class, and none under reduced motion', () => {
    expect(movementClass('step-in', false)).toBe('animate-step-in');
    expect(movementClass('step-back', false)).toBe('animate-step-back');
    expect(movementClass('mark-settle', false)).toBe('animate-mark-settle');
    expect(movementClass('nudge', false)).toBe('animate-nudge');
    expect(movementClass('nudge', true)).toBe('');
  });

  test('follows the preference when it changes while the screen is open, and stops listening when it closes', async () => {
    let matches = false;
    const listeners = new Set<() => void>();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        get matches(): boolean {
          return matches;
        },
        addEventListener: (_: string, fn: () => void): void => {
          listeners.add(fn);
        },
        removeEventListener: (_: string, fn: () => void): void => {
          listeners.delete(fn);
        },
      }),
    });
    const view = await renderApp(<Probe />);
    expect(view.getByText('moving')).toBeDefined();
    expect(listeners.size).toBe(1);
    matches = true;
    act(() => {
      for (const notify of listeners) notify();
    });
    expect(view.getByText('still')).toBeDefined();
    view.unmount();
    expect(listeners.size).toBe(0);
  });
});
