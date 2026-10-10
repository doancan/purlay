/**
 * The test harness is tested — a check that has only ever said yes is not known to
 * say no (`CONTRIBUTING.md` §6.4). The accessibility helper must fail on a page
 * that is inaccessible, and the fakes must do what the application's ports ask.
 */
import { installDom } from './dom';
import { describe, expect, test } from 'bun:test';
import { render } from '@testing-library/react';
import { expectNoAxeViolations } from './axe';
import { fakeColourScheme, fakeHistory, fakeSchedule, memoryStorage } from './fakes';
import { renderApp } from './render';
import { person } from './user';

installDom();

describe('expectNoAxeViolations', () => {
  test('passes an accessible fragment', async () => {
    const { container } = render(
      <main>
        <h1>Hi</h1>
        <button type="button">Go</button>
      </main>,
    );
    await expectNoAxeViolations(container);
  });

  test('fails an inaccessible one, and says which rule and which element', async () => {
    const { container } = render(
      <main>
        <img src="x.png" />
        <button type="button" />
      </main>,
    );
    let message = '';
    try {
      await expectNoAxeViolations(container);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('image-alt');
    expect(message).toContain('button-name');
  });
});

describe('renderApp', () => {
  test('mounts the same providers the application does, with the words loaded', async () => {
    const { getByText, world } = await renderApp(<p>hello</p>, { path: '/w/acme' });
    expect(getByText('hello')).toBeDefined();
    expect(world.history.read().pathname).toBe('/w/acme');
    expect(world.page.attributes['lang']).toBe('en');
  });

  test('starts in the theme the person chose, else the operating system’s', async () => {
    const chosen = await renderApp(<p>a</p>, { theme: 'dark', dark: false });
    expect(chosen.world.page.attributes['data-theme']).toBe('dark');
    const system = await renderApp(<p>b</p>, { dark: true });
    expect(system.world.page.attributes['data-theme']).toBe('dark');
  });
});

describe('the fakes', () => {
  test('storage remembers', () => {
    const storage = memoryStorage({ a: '1' });
    storage.setItem('b', '2');
    expect(storage.getItem('a')).toBe('1');
    expect(storage.getItem('b')).toBe('2');
    expect(storage.getItem('c')).toBeNull();
  });

  test('history has Back, and counts its listeners', () => {
    const history = fakeHistory('/a?x=1');
    expect(history.read()).toEqual({ pathname: '/a', search: '?x=1' });
    const stop = history.listen(() => undefined);
    expect(history.listeners()).toBe(1);
    history.push('/b');
    history.back();
    expect(history.read().pathname).toBe('/a');
    stop();
    expect(history.listeners()).toBe(0);
  });

  test('a timer runs when its time comes, in order, and not when cancelled', () => {
    const clock = fakeSchedule();
    const ran: string[] = [];
    clock.schedule(() => ran.push('late'), 20);
    clock.schedule(() => ran.push('early'), 10);
    const cancel = clock.schedule(() => ran.push('never'), 10);
    cancel();
    expect(clock.pending()).toBe(2);
    clock.advance(10);
    expect(ran).toEqual(['early']);
    clock.advance(10);
    expect(ran).toEqual(['early', 'late']);
    expect(clock.pending()).toBe(0);
  });

  test('the colour scheme tells whoever listens when it changes', () => {
    const scheme = fakeColourScheme(false);
    let heard = 0;
    const listener = (): void => {
      heard += 1;
    };
    scheme.addEventListener('change', listener);
    scheme.flip(true);
    expect(scheme.matches).toBe(true);
    scheme.removeEventListener('change', listener);
    scheme.flip(false);
    expect(heard).toBe(1);
  });
});

describe('person', () => {
  test('types, one change per key', async () => {
    const { getByLabelText } = render(<input aria-label="x" />);
    await person().type(getByLabelText('x'), 'abc');
    expect((getByLabelText('x') as HTMLInputElement).value).toBe('abc');
  });
});
