/**
 * The key cap: one cap per key, the glyphs of the keyboard it is printed for, and the `+` a screen reader
 * says between keys off a Mac.
 */
import { installDom } from '../testing/dom';
import { describe, expect, test } from 'bun:test';
import { expectNoAxeViolations } from '../testing/axe';
import { renderApp } from '../testing/render';
import { Kbd } from './kbd';

installDom();

/** The caps drawn: the innermost `<kbd>`s, each one key. */
const capsOf = (container: HTMLElement): readonly string[] =>
  [...container.querySelectorAll('kbd')]
    .filter((key) => key.querySelector('kbd') === null)
    .map((key) => key.textContent);

describe('Kbd', () => {
  test('on a Mac a chord is the glyphs, a cap each, with nothing between them', async () => {
    const { container } = await renderApp(<Kbd mac>Mod+Shift+Enter</Kbd>);
    expect(capsOf(container)).toEqual(['⇧', '⌘', '↵']);
    expect(container.textContent).toBe('⇧⌘↵');
    await expectNoAxeViolations(container);
  });

  test('elsewhere it is the words, and the `+` between them is said', async () => {
    const { container } = await renderApp(<Kbd mac={false}>Mod+Shift+R</Kbd>);
    expect(capsOf(container)).toEqual(['Ctrl', 'Shift', 'R']);
    expect(container.textContent).toBe('Ctrl+Shift+R');
    await expectNoAxeViolations(container);
  });

  test('a chord is one <kbd> holding a <kbd> per key, as the HTML spec writes one', async () => {
    const { container } = await renderApp(<Kbd mac>⌘K</Kbd>);
    const outer = container.firstElementChild;
    expect(outer?.tagName).toBe('KBD');
    expect([...(outer?.children ?? [])].map((child) => child.tagName)).toEqual(['KBD', 'KBD']);
  });

  test('a single key is a single cap', async () => {
    const { container } = await renderApp(<Kbd mac>Esc</Kbd>);
    expect(container.querySelectorAll('kbd')).toHaveLength(1);
    expect(container.textContent).toBe('esc');
  });

  test('without a platform it prints for this browser', async () => {
    const { container } = await renderApp(<Kbd>Mod+K</Kbd>);
    const mac = /mac|iphone|ipad|ipod/i.test(navigator.platform);
    expect(capsOf(container)).toEqual(mac ? ['⌘', 'K'] : ['Ctrl', 'K']);
  });

  test('is not drawn on a device that is only touch', async () => {
    const { container } = await renderApp(<Kbd mac>⌘K</Kbd>);
    expect(container.firstElementChild?.className).toContain('touch-only:hidden');
  });

  test('is drawn there too where a caller shows it: the reference of shortcuts', async () => {
    const { container } = await renderApp(
      <>
        <Kbd mac touch="show">
          ⌘K
        </Kbd>
        <Kbd mac touch="show">
          Esc
        </Kbd>
      </>,
    );
    expect(container.innerHTML).not.toContain('touch-only:hidden');
    expect(container.querySelectorAll('kbd')).toHaveLength(4);
  });
});
