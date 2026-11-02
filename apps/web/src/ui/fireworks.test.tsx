import { installDom } from '../testing/dom';
import { afterEach, describe, expect, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import { renderApp } from '../testing/render';
import { celebrate } from './celebrate';
import { Fireworks } from './fireworks';

installDom();

const original = globalThis.matchMedia;
afterEach(() => {
  globalThis.matchMedia = original;
});

const pending = (show: HTMLElement): Element[] => [...show.querySelectorAll(':scope > g')];

describe('Fireworks', () => {
  test('draws nothing until a celebration, then a hidden, pointer-less show that removes itself', async () => {
    const view = await renderApp(<Fireworks random={() => 0} />);
    expect(view.queryByTestId('fireworks')).toBeNull();
    act(() => {
      celebrate();
    });
    const show = view.getByTestId('fireworks');
    expect(show.getAttribute('aria-hidden')).toBe('true');
    // A rocket reaching its top is not the end; only the sparks' sinking is.
    for (const group of pending(view.getByTestId('fireworks'))) {
      fireEvent.animationEnd(group, { animationName: 'firework-rocket' });
    }
    expect(view.queryByTestId('fireworks')).not.toBeNull();
    for (const group of pending(view.getByTestId('fireworks'))) {
      fireEvent.animationEnd(group, { animationName: 'firework-fall' });
    }
    expect(view.queryByTestId('fireworks')).toBeNull();
  });

  test('five different shows come up, and never the same one twice running', async () => {
    let step = 0;
    const view = await renderApp(<Fireworks random={() => (step++ % 7) / 7} />);
    const seen: string[] = [];
    for (let each = 0; each < 40; each++) {
      act(() => {
        celebrate();
      });
      seen.push(view.getByTestId('fireworks').getAttribute('data-show') ?? '');
    }
    expect(new Set(seen).size).toBe(5);
    for (let each = 1; each < seen.length; each++) expect(seen[each]).not.toBe(seen[each - 1]);
  });

  test('a second celebration restarts the show', async () => {
    const { getByTestId } = await renderApp(<Fireworks random={() => 0.5} />);
    act(() => {
      celebrate();
    });
    const first = getByTestId('fireworks');
    act(() => {
      celebrate();
    });
    expect(getByTestId('fireworks')).not.toBe(first);
  });

  test('is not drawn for a person who asked for less motion', async () => {
    globalThis.matchMedia = ((query: string) => ({
      matches: query.includes('reduce'),
    })) as typeof matchMedia;
    const { queryByTestId } = await renderApp(<Fireworks />);
    act(() => {
      celebrate();
    });
    expect(queryByTestId('fireworks')).toBeNull();
  });
});
