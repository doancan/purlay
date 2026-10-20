/**
 * The keys that work everywhere: which chord does what, which are left alone, and that
 * the composer is no exception. Events are dispatched at the document the way a browser
 * delivers them from whatever has focus.
 */
import { describe, expect, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import type { Channel } from '@purlay/types';
import { installDom } from '../../testing/dom';
import { IDS, aChannel, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { SessionGate } from '../session/session';
import { GlobalKeys } from './global-keys';
import { WorkspaceScopeProvider } from './workspace';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const unread = (n: number): Channel['state'] => ({
  lastReadMessageId: null,
  unreadCount: n,
  unreadMentionCount: 0,
});

/** api (open) quiet; deploys and incidents have something unread; sidebar order is api, deploys, incidents. */
const channels = (): Channel[] => [
  aChannel(IDS.api, 'api', { lastMessageAt: '2026-09-09T09:00:00.000Z' }),
  aChannel(IDS.deploys, 'deploys', { lastMessageAt: '2026-09-09T08:00:00.000Z', state: unread(2) }),
  aChannel(IDS.incidents, 'incidents', {
    lastMessageAt: '2026-09-09T07:00:00.000Z',
    state: unread(1),
  }),
];

const mount = async (
  list: Channel[] = channels(),
  path = `/w/acme/c/${IDS.api}`,
  platform?: { platform: string },
): Promise<{ view: Awaited<ReturnType<typeof renderApp>>; here: () => string }> => {
  const view = await renderApp(
    <SessionGate>
      <WorkspaceScopeProvider slug="acme" notFound={null}>
        <GlobalKeys {...(platform === undefined ? {} : { platform })} />
        <textarea aria-label="composer" />
      </WorkspaceScopeProvider>
    </SessionGate>,
    { api: aSignedInApi({ channels: () => Promise.resolve(list) }), path },
  );
  await settle();
  return { view, here: () => view.world.history.stack.at(-1) ?? '' };
};

const press = (init: KeyboardEventInit, target: Element | Document = document): boolean =>
  fireEvent.keyDown(target, init);

describe('Cmd/Ctrl+K', () => {
  test('opens the command palette, and the same chord closes it', async () => {
    const { view } = await mount();
    expect(view.queryByRole('dialog')).toBeNull();
    press({ key: 'k', metaKey: true });
    await settle();
    expect(view.getByRole('combobox')).toBeDefined();
    press({ key: 'k', ctrlKey: true });
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
  });

  test('takes the chord from the browser', async () => {
    const { view } = await mount();
    expect(press({ key: 'k', metaKey: true })).toBe(false);
    await settle();
    expect(view.getByRole('dialog')).toBeDefined();
  });

  test('works from inside the composer, and with caps lock on', async () => {
    const { view } = await mount();
    const composer = view.getByLabelText('composer');
    act(() => {
      composer.focus();
    });
    press({ key: 'K', ctrlKey: true }, composer);
    await settle();
    expect(view.getByRole('combobox')).toBeDefined();
  });

  test.each([
    ['without a modifier', { key: 'k' }],
    ['with Shift', { key: 'k', metaKey: true, shiftKey: true }],
    ['with Alt', { key: 'k', metaKey: true, altKey: true }],
  ])('is not the chord %s', async (_why, init) => {
    const { view } = await mount();
    expect(press(init)).toBe(true);
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
  });
});

describe('Cmd/Ctrl+, (D-146)', () => {
  test('opens Settings from anywhere, the composer included, taking the chord from the browser', async () => {
    const { view, here } = await mount();
    const composer = view.getByLabelText('composer');
    act(() => {
      composer.focus();
    });
    expect(press({ key: ',', ctrlKey: true }, composer)).toBe(false);
    await settle();
    expect(here()).toBe('/w/acme/settings');
  });

  test('closes an overlay that is open as it goes', async () => {
    const { view, here } = await mount();
    press({ key: 'k', metaKey: true });
    await settle();
    expect(view.getByRole('dialog')).toBeDefined();
    press({ key: ',', metaKey: true });
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(here()).toBe('/w/acme/settings');
  });

  test.each([
    ['without a modifier', { key: ',' }],
    ['with Shift', { key: ',', metaKey: true, shiftKey: true }],
    ['with Alt', { key: ',', metaKey: true, altKey: true }],
  ])('is not the chord %s', async (_why, init) => {
    const { here } = await mount();
    expect(press(init)).toBe(true);
    await settle();
    expect(here()).toBe(`/w/acme/c/${IDS.api}`);
  });
});

describe('Cmd/Ctrl+/', () => {
  test('opens the shortcut reference, and the same chord closes it', async () => {
    const { view } = await mount();
    press({ key: '/', metaKey: true });
    await settle();
    expect(view.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeDefined();
    press({ key: '/', ctrlKey: true });
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
  });

  test('works where / needs Shift, as on a Turkish keyboard', async () => {
    const { view } = await mount();
    expect(press({ key: '/', metaKey: true, shiftKey: true })).toBe(false);
    await settle();
    expect(view.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeDefined();
  });

  test('is not the chord with Alt, or without a modifier', async () => {
    const { view } = await mount();
    press({ key: '/', metaKey: true, altKey: true });
    press({ key: '/' });
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
  });

  test('opening one overlay replaces the other, never stacks them', async () => {
    const { view } = await mount();
    press({ key: 'k', metaKey: true });
    await settle();
    press({ key: '/', metaKey: true });
    await settle();
    expect(view.getAllByRole('dialog')).toHaveLength(1);
    expect(view.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeDefined();
    press({ key: 'k', metaKey: true });
    await settle();
    expect(view.getByRole('combobox')).toBeDefined();
  });

  test('prints the keys of the platform in front of the person', async () => {
    const mac = await mount(channels(), `/w/acme/c/${IDS.api}`, { platform: 'MacIntel' });
    press({ key: '/', metaKey: true });
    await settle();
    expect(mac.view.getByRole('dialog').textContent).toContain('⌘');
    expect(mac.view.getByRole('dialog').textContent).not.toContain('Ctrl');
    mac.view.unmount();

    const pc = await mount(channels(), `/w/acme/c/${IDS.api}`, { platform: 'Win32' });
    press({ key: '/', ctrlKey: true });
    await settle();
    expect(pc.view.getByRole('dialog').textContent).toContain('Ctrl');
  });

  test('reads the platform from the browser when it is not told', async () => {
    const { view } = await mount();
    press({ key: '/', metaKey: true });
    await settle();
    expect(view.getByRole('dialog', { name: 'Keyboard shortcuts' }).textContent).toMatch(/⌘|Ctrl/);
  });
});

describe('Alt+↑ and Alt+↓', () => {
  test('go to the next and the previous channel with something unread, in the sidebar order', async () => {
    const { here } = await mount();
    press({ key: 'ArrowDown', altKey: true });
    await settle();
    expect(here()).toBe(`/w/acme/c/${IDS.deploys}`);
    press({ key: 'ArrowDown', altKey: true });
    await settle();
    expect(here()).toBe(`/w/acme/c/${IDS.incidents}`);
    press({ key: 'ArrowUp', altKey: true });
    await settle();
    expect(here()).toBe(`/w/acme/c/${IDS.deploys}`);
  });

  test('wrap round the ends', async () => {
    const { here } = await mount(channels(), `/w/acme/c/${IDS.incidents}`);
    press({ key: 'ArrowDown', altKey: true });
    await settle();
    expect(here()).toBe(`/w/acme/c/${IDS.deploys}`);
    press({ key: 'ArrowUp', altKey: true });
    await settle();
    expect(here()).toBe(`/w/acme/c/${IDS.incidents}`);
  });

  test('say where they went, politely', async () => {
    const { view } = await mount();
    press({ key: 'ArrowDown', altKey: true });
    await settle();
    expect(view.getAllByRole('status').some((node) => node.textContent === 'Opened deploys')).toBe(
      true,
    );
  });

  test('do nothing when nothing else is unread, but still keep the browser from going Back', async () => {
    const quiet = channels().map((c) => ({ ...c, state: unread(0) }));
    const { here } = await mount(quiet);
    expect(press({ key: 'ArrowDown', altKey: true })).toBe(false);
    await settle();
    expect(here()).toBe(`/w/acme/c/${IDS.api}`);
  });

  test('work from the composer', async () => {
    const { view, here } = await mount();
    const composer = view.getByLabelText('composer');
    press({ key: 'ArrowDown', altKey: true }, composer);
    await settle();
    expect(here()).toBe(`/w/acme/c/${IDS.deploys}`);
  });

  test('are not the chord with another modifier beside Alt', async () => {
    const { here } = await mount();
    expect(press({ key: 'ArrowDown', altKey: true, shiftKey: true })).toBe(true);
    expect(press({ key: 'ArrowDown', altKey: true, ctrlKey: true })).toBe(true);
    expect(press({ key: 'ArrowDown' })).toBe(true);
    await settle();
    expect(here()).toBe(`/w/acme/c/${IDS.api}`);
  });

  test('leave the page alone while an overlay is open', async () => {
    const { view, here } = await mount();
    press({ key: 'k', metaKey: true });
    await settle();
    expect(press({ key: 'ArrowDown', altKey: true }, view.getByRole('combobox'))).toBe(false);
    await settle();
    expect(here()).toBe(`/w/acme/c/${IDS.api}`);
  });

  test('from a view that is not a channel start at the end they are travelling from', async () => {
    const { here } = await mount(channels(), '/w/acme/questions');
    press({ key: 'ArrowDown', altKey: true });
    await settle();
    expect(here()).toBe(`/w/acme/c/${IDS.deploys}`);
  });

  test('name a direct message by the other person', async () => {
    const dm = aChannel(IDS.dm, null, {
      type: 'direct_message',
      peer: { id: IDS.alice, username: 'alice', displayName: 'Alice', avatarUrl: null },
      state: unread(1),
    });
    const [first] = channels();
    if (first === undefined) throw new Error('no channels');
    const { view } = await mount([first, dm]);
    press({ key: 'ArrowDown', altKey: true });
    await settle();
    expect(view.getAllByRole('status').some((node) => node.textContent === 'Opened Alice')).toBe(
      true,
    );
  });
});

describe('closing what they opened', () => {
  test("Escape, which is Radix's, closes either overlay and leaves the keys working", async () => {
    const { view } = await mount();
    press({ key: 'k', metaKey: true });
    await settle();
    await person().keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    press({ key: '/', metaKey: true });
    await settle();
    await person().keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    press({ key: 'k', metaKey: true });
    await settle();
    expect(view.getByRole('combobox')).toBeDefined();
  });
});

describe('events somebody else handled', () => {
  test('are left alone: one that was already prevented', async () => {
    const { view } = await mount();
    const composer = view.getByLabelText('composer');
    composer.addEventListener('keydown', (event) => {
      event.preventDefault();
    });
    press({ key: 'k', metaKey: true }, composer);
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
  });

  test('and a key pressed while an IME is composing', async () => {
    const { view } = await mount();
    press({ key: 'k', metaKey: true, isComposing: true });
    press({ key: 'ArrowDown', altKey: true, isComposing: true });
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
  });

  test('and everything else', async () => {
    const { view, here } = await mount();
    for (const key of ['t', 'r', 'ArrowDown', 'Enter', 'Escape']) press({ key });
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(here()).toBe(`/w/acme/c/${IDS.api}`);
  });
});
