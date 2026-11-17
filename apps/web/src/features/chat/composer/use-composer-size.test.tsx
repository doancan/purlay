import { expect, mock, test } from 'bun:test';
import { act, render } from '@testing-library/react';
import { createRef } from 'react';
import { installDom } from '../../../testing/dom';
import { useComposerSize } from './use-composer-size';

installDom();

test('a width change refits wrapped text, keeps its own scroll position and respects the viewport', () => {
  const previous = globalThis.ResizeObserver;
  const viewportDescriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  const viewport = Object.assign(new EventTarget(), { height: 500 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  let notify: (() => void) | undefined;
  const disconnected = mock((): void => undefined);
  globalThis.ResizeObserver = class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      notify = (): void => {
        callback([], this);
      };
    }
    observe(): void {
      return undefined;
    }
    unobserve(): void {
      return undefined;
    }
    disconnect(): void {
      disconnected();
    }
  };
  const ref = createRef<HTMLTextAreaElement>();
  const Field = ({ hidden = false }: { readonly hidden?: boolean }): React.JSX.Element => {
    useComposerSize(ref, 'wrapped words', !hidden);
    return <textarea ref={ref} hidden={hidden} style={{ fontSize: '16px', lineHeight: '20px' }} />;
  };
  try {
    const mounted = render(<Field />);
    const box = ref.current;
    if (box === null) throw new Error('Missing writing field');
    let width = 200;
    let height = 100;
    box.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, width, 40);
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: (): number => height });
    Object.defineProperty(box, 'clientHeight', { configurable: true, get: (): number => 40 });
    box.scrollTop = 20;
    fireResize();
    expect(box.style.height).toBe('100px');
    expect(box.scrollTop).toBe(20);
    // Establish the observed width; a height-only notification then cannot falsely refit it.
    act(() => {
      notify?.();
    });
    height = 180;
    act(() => {
      notify?.();
    });
    expect(box.style.height).toBe('100px');
    width = 120;
    act(() => {
      notify?.();
    });
    expect(box.style.height).toBe('180px');
    expect(box.scrollTop).toBe(20);
    height = 800;
    act(() => {
      viewport.dispatchEvent(new Event('resize'));
    });
    expect(box.style.height).toBe('200px');
    mounted.rerender(<Field hidden />);
    height = 100;
    fireResize();
    expect(box.style.height).toBe('200px');
    mounted.unmount();
    expect(disconnected).toHaveBeenCalledTimes(1);
  } finally {
    globalThis.ResizeObserver = previous;
    if (viewportDescriptor === undefined) Reflect.deleteProperty(window, 'visualViewport');
    else Object.defineProperty(window, 'visualViewport', viewportDescriptor);
  }
});

const fireResize = (): void => {
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
};
