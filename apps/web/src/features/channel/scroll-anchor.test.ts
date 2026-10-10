/** The row the reader is on: named before older messages arrive above it, and put back after. */
import { describe, expect, test } from 'bun:test';
import { installDom } from '../../testing/dom';
import { holdAnchor, readAnchor } from './scroll';

installDom();

describe('the row the reader is on', () => {
  /** A box and rows with the positions a layout would give them, in page coordinates. */
  const layout = (
    box: number,
    rows: readonly { readonly id: string; readonly top: number; readonly height: number }[],
  ): HTMLElement => {
    const element = document.createElement('div');
    element.getBoundingClientRect = (): DOMRect => ({ top: box }) as DOMRect;
    for (const row of rows) {
      const node = document.createElement('article');
      node.setAttribute('data-message-row', '');
      node.dataset['messageId'] = row.id;
      node.getBoundingClientRect = (): DOMRect =>
        ({ top: row.top, bottom: row.top + row.height }) as DOMRect;
      element.append(node);
    }
    return element;
  };

  test('is the first row with any of itself in sight, and how far below the top it is', () => {
    const box = layout(100, [
      { id: 'a', top: 0, height: 60 },
      { id: 'b', top: 80, height: 60 },
      { id: 'c', top: 140, height: 60 },
    ]);
    expect(readAnchor(box)).toEqual({ id: 'b', offset: -20 });
    expect(readAnchor(layout(0, []))).toBeNull();
    expect(readAnchor(layout(500, [{ id: 'a', top: 0, height: 10 }]))).toBeNull();
  });

  test('is put back where it was even when its own height changed: the box moves by what the row moved', () => {
    const box = layout(100, [{ id: 'b', top: 148, height: 40 }]);
    box.scrollTop = 2314;
    holdAnchor(box, { id: 'b', offset: 24 });
    // The row sits 48 below the box's top and was 24 below it: the box scrolls down by 24.
    expect(box.scrollTop).toBe(2338);
  });

  test('is left alone when it is where it was, when it is gone, and when there was none', () => {
    const box = layout(100, [{ id: 'b', top: 124, height: 40 }]);
    box.scrollTop = 50;
    holdAnchor(box, { id: 'b', offset: 24 });
    holdAnchor(box, { id: 'missing', offset: 0 });
    holdAnchor(box, null);
    expect(box.scrollTop).toBe(50);
  });
});
