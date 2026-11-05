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

/** A window of this size, until the returned function puts the old one back. */
const sized = (width: number, height: number): (() => void) => {
  const before = [globalThis.innerWidth, globalThis.innerHeight] as const;
  globalThis.innerWidth = width;
  globalThis.innerHeight = height;
  return () => {
    globalThis.innerWidth = before[0];
    globalThis.innerHeight = before[1];
  };
};

/** How many bursts each of the five shows has (`SHOWS`, in order). */
const SHOW_SIZES = [5, 3, 3, 6, 5];

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

  describe('a grand moment is one run, not a chain (D-261)', () => {
    test('two different shows in one smooth run over its own, longer length, ended by its last burst', async () => {
      const restore = sized(1024, 1000); // taller than wide: no sides, so the count is the two shows'
      try {
        const view = await renderApp(<Fireworks random={() => 0.3} />);
        act(() => {
          celebrate('grand');
        });
        const show = view.getByTestId('fireworks');
        expect(show.getAttribute('data-grand')).toBe('true');
        // The run's length is the token's, spread over what its bursts add up to — the same four and a half seconds
        // whichever two shows came up.
        expect(show.getAttribute('style')).toMatch(
          /--duration-celebrate: calc\(var\(--duration-celebrate-grand\) \/ [\d.]+\)/,
        );
        // Both shows' bursts are in the one run — more than any single show has.
        const biggest = Math.max(...SHOW_SIZES);
        expect(pending(show).length).toBeGreaterThan(biggest);
        // Rockets are not the end; only the sparks sinking is, and then the whole run goes at once.
        for (const group of pending(show)) {
          fireEvent.animationEnd(group, { animationName: 'firework-rocket' });
        }
        expect(view.queryByTestId('fireworks')).not.toBeNull();
        for (const group of pending(view.getByTestId('fireworks'))) {
          fireEvent.animationEnd(group, { animationName: 'firework-fall' });
        }
        expect(view.queryByTestId('fireworks')).toBeNull();
      } finally {
        restore();
      }
    });

    test('the run is paced by its last burst: that burst plus its sinking sparks is the token, whichever shows came up', async () => {
      for (const roll of [0, 0.3, 0.6, 0.9]) {
        const view = await renderApp(<Fireworks random={() => roll} />);
        act(() => {
          celebrate('grand');
        });
        const show = view.getByTestId('fireworks');
        // Every delay is `calc(var(--duration-celebrate) * at)`: the latest of them is the last burst's, and a
        // burst's sparks sink for 0.55 of the show after it opens — the end of the run, in shows' lengths.
        const delays = [...show.innerHTML.matchAll(/--duration-celebrate\) \* ([\d.]+)\)/g)].map(
          (found) => Number(found[1]),
        );
        const pace = /\/ ([\d.]+)\)/.exec(show.getAttribute('style') ?? '')?.[1];
        expect(Math.max(...delays) + 0.55).toBeCloseTo(Number(pace), 2);
        view.unmount();
      }
    });

    test('a small one keeps the length it always had, and does not fold in a second show', async () => {
      const view = await renderApp(<Fireworks random={() => 0.3} />);
      act(() => {
        celebrate();
      });
      const show = view.getByTestId('fireworks');
      expect(show.getAttribute('data-grand')).toBeNull();
      expect(show.getAttribute('style')).toBeNull();
      expect(pending(show).length).toBeLessThanOrEqual(Math.max(...SHOW_SIZES));
    });

    test('the second show is a different one, whatever the dice say', async () => {
      const view = await renderApp(<Fireworks random={() => 0} />);
      for (let each = 0; each < 6; each++) {
        act(() => {
          celebrate('grand');
        });
        const show = view.getByTestId('fireworks');
        // Folding in the same show would be one show's bursts twice: the count would be exactly double.
        const first = SHOW_SIZES[Number(show.getAttribute('data-show'))] ?? 0;
        expect(pending(show).length).not.toBe(first * 2);
      }
    });
  });

  describe('a bigger moment on a wide screen also lights the sides (D-261)', () => {
    test('a wide window gets a wider field and four more bursts, out on either side of the middle', async () => {
      const restore = sized(1440, 900);
      try {
        const view = await renderApp(<Fireworks random={() => 0} />);
        act(() => {
          celebrate('grand');
        });
        const show = view.getByTestId('fireworks');
        expect(show.getAttribute('viewBox')).toBe('-30 0 160 100');
        const plain = SHOW_SIZES[Number(show.getAttribute('data-show'))] ?? 0;
        expect(pending(show).length).toBeGreaterThan(plain + 4);
        // Some of the extra bursts open to the left of the field the other shows use, some to the right.
        const xs = [...show.querySelectorAll('g[transform^="translate("]')].map((group) =>
          Number(/translate\((-?\d+(?:\.\d+)?)/.exec(group.getAttribute('transform') ?? '')?.[1]),
        );
        expect(xs.some((x) => x < 0)).toBe(true);
        expect(xs.some((x) => x > 100)).toBe(true);
      } finally {
        restore();
      }
    });

    test('a single 🎉 stays in the middle field, and so does a narrow window, whatever was asked', async () => {
      const restore = sized(1440, 900);
      try {
        const view = await renderApp(<Fireworks random={() => 0} />);
        act(() => {
          celebrate();
        });
        expect(view.getByTestId('fireworks').getAttribute('viewBox')).toBe('0 0 100 100');
        restore();
        const narrow = sized(390, 844);
        act(() => {
          celebrate('grand');
        });
        expect(view.getByTestId('fireworks').getAttribute('viewBox')).toBe('0 0 100 100');
        narrow();
      } finally {
        restore();
      }
    });
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
