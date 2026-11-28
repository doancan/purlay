import { installDom } from '../testing/dom';
import { afterEach, describe, expect, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import { renderApp } from '../testing/render';
import { celebrate } from './celebrate';
import { Confetti } from './confetti';

installDom();

const original = globalThis.matchMedia;
afterEach(() => {
  globalThis.matchMedia = original;
});

describe('Confetti', () => {
  test('draws nothing until a celebration, then a hidden, pointer-less throw that removes itself', async () => {
    const view = await renderApp(<Confetti random={() => 0.5} />);
    expect(view.queryByTestId('confetti')).toBeNull();
    act(() => {
      celebrate();
    });
    const layer = view.getByTestId('confetti');
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    expect(layer.children.length).toBeGreaterThan(40);
    // Only the last piece to land ends it: the others landing is not the end.
    const [last, ...others] = [...layer.children].reverse();
    for (const piece of others) fireEvent.animationEnd(piece);
    expect(view.queryByTestId('confetti')).not.toBeNull();
    if (last === undefined) throw new Error('the throw drew no pieces');
    fireEvent.animationEnd(last);
    expect(view.queryByTestId('confetti')).toBeNull();
  });

  test('a second celebration during the first restarts the throw', async () => {
    const view = await renderApp(<Confetti random={() => 0.3} />);
    act(() => {
      celebrate();
    });
    const first = view.getByTestId('confetti');
    act(() => {
      celebrate();
    });
    expect(view.getByTestId('confetti')).not.toBe(first);
  });

  test('a person who asked for less motion gets none', async () => {
    globalThis.matchMedia = ((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    })) as unknown as typeof matchMedia;
    const view = await renderApp(<Confetti />);
    act(() => {
      celebrate();
    });
    expect(view.queryByTestId('confetti')).toBeNull();
  });
});
