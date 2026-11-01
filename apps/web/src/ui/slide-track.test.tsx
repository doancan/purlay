import { installDom } from '../testing/dom';
import { describe, expect, test } from 'bun:test';
import { renderApp } from '../testing/render';
import { SlideTrack } from './slide-track';

installDom();

const tabs = (chosen: 'a' | 'b'): React.JSX.Element => (
  <SlideTrack memory="test-track" role="tablist" mark="underline">
    <button role="tab" aria-selected={chosen === 'a'}>
      A
    </button>
    <button role="tab" aria-selected={chosen === 'b'}>
      B
    </button>
  </SlideTrack>
);

describe('SlideTrack', () => {
  test('draws one hidden mark under the segments', async () => {
    const { container } = await renderApp(tabs('a'));
    const marks = container.querySelectorAll('[role="tablist"] > span[aria-hidden="true"]');
    expect(marks.length).toBe(1);
  });

  test('follows the chosen segment when the choice changes', async () => {
    const { container, rerender } = await renderApp(tabs('a'));
    const mark = container.querySelector<HTMLElement>('[role="tablist"] > span');
    if (mark === null) throw new Error('no mark');
    expect(mark.style.opacity).toBe('1');
    rerender(tabs('b'));
    expect(mark.style.transform).toContain('translateX');
  });

  test('a track with nothing chosen hides its mark, and one on a new screen starts where it stood', async () => {
    const none = await renderApp(
      <SlideTrack memory="empty" as="nav" aria-label="views">
        <a href="#x">x</a>
      </SlideTrack>,
    );
    expect(none.container.querySelector<HTMLElement>('nav > span')?.style.opacity).toBe('0');
    const first = await renderApp(tabs('a'));
    first.unmount();
    const second = await renderApp(tabs('b'));
    expect(second.container.querySelector('[role="tablist"] > span')).not.toBeNull();
  });
});
