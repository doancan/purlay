/**
 * The release notes, once per version per browser (D-248), through the real signed-in frame: the window opens on the
 * first screen after an update, closing it by any means is remembered, the same version never opens it again
 * here and a new one does — and nothing that goes wrong with storage, the notes or the server holds the app up.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import type { ClientStorage } from '../../data/browser-storage';
import { installDom } from '../../testing/dom';
import { memoryStorage } from '../../testing/fakes';
import { aSignedInApi } from '../../testing/fixtures';
import { Fireworks } from '../../ui/fireworks';
import { notesFor } from '../../testing/release-notes';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { RELEASE_NOTES_SEEN_KEY } from './release-notes-once';
import type { ReleaseNotesSource } from './release-notes-source';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const version = (value: string): Partial<Api> => ({
  latestRelease: () => Promise.resolve({ current: value, latest: null }),
});

const visit = async (
  options: {
    running?: string;
    storage?: ClientStorage | null;
    notes?: ReleaseNotesSource | null;
    path?: string;
    api?: Partial<Api>;
  } = {},
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const {
    running = '1.0.0',
    storage = memoryStorage(),
    notes = notesFor('1.0.0', '1.1.0'),
    path = '/w/acme',
    api = {},
  } = options;
  // The frame draws the fireworks (`app.tsx`); this harness has no frame, so it brings them.
  const view = await renderApp(
    <>
      <Outlet />
      <Fireworks />
    </>,
    {
      path,
      api: aSignedInApi({ ...version(running), ...api }),
      storage,
      releaseNotes: notes,
    },
  );
  await settle();
  return view;
};

// A boolean, not the element: a failed assertion about a whole page prints the page, and the page is enormous.
const isOpen = (view: Awaited<ReturnType<typeof renderApp>>): boolean =>
  view.queryByRole('dialog') !== null;

const DIALOG = { name: 'What’s new in Purlay 1.0.0' };

describe('the release notes after an update', () => {
  test('open once on the first screen: labelled, with the notes by category, and Got it remembers the version', async () => {
    const storage = memoryStorage();
    const view = await visit({ storage });
    const dialog = await view.findByRole('dialog', DIALOG);
    expect(within(dialog).getByText('Released Oct 26, 2026.')).toBeDefined();
    // What the release is about comes first, in a light blue block, each big thing a title and its sentence.
    const featured = within(dialog)
      .getByRole('heading', { level: 3, name: 'Featured' })
      .closest('section');
    expect(featured?.className).toContain('bg-accent-subtle');
    expect(featured?.textContent).toContain('Editor');
    expect(featured?.textContent).toContain('It reads what you paste: a table stays a table');
    // It is the first thing in the window, ahead of every category.
    const headings = within(dialog)
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(['Featured', 'New2', 'Fixed1', 'Security1']);
    // Every other category is a plain list under a quiet heading — a dot, a word, a count — never a pill that
    // would read as a button: there is no button in the window but the ones that act.
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((button) => button.textContent || button.getAttribute('aria-label'))
        .sort(),
    ).toEqual(['Close', 'Got it']);
    const added = within(dialog)
      .getByRole('heading', { level: 3, name: /^New/ })
      .closest('section');
    if (added === null) throw new Error('the New category has no section');
    expect(within(added).getAllByRole('listitem')).toHaveLength(2);
    // The area is a small label above the words; a bullet with none is its words alone.
    expect(within(dialog).getByText('Messages').tagName).toBe('SPAN');
    expect(within(dialog).getByText('A bullet that names no area')).toBeDefined();
    // It is a link out to the release, in a new tab, and says so.
    const github = within(dialog).getByRole('link', { name: /View on GitHub/ });
    expect(github.getAttribute('href')).toBe(
      'https://github.com/doancan/purlay/releases/tag/v1.0.0',
    );
    expect(github.getAttribute('target')).toBe('_blank');
    // Its scrollbar is drawn under the pointer only.
    expect(within(dialog).getByRole('region').className).toContain('scrollbar-hover');
    expect(within(dialog).getByText('day dividers').tagName).toBe('CODE');
    expect(storage.data[RELEASE_NOTES_SEEN_KEY]).toBeUndefined();

    await person().click(within(dialog).getByRole('button', { name: 'Got it' }));
    await settle();
    expect(isOpen(view)).toBe(false);
    expect(storage.data[RELEASE_NOTES_SEEN_KEY]).toBe('1.0.0');
    view.unmount();
  });

  test('opens with fireworks over it — a few shows, for a release — and none for a person who asked for less motion', async () => {
    const view = await visit({ storage: memoryStorage() });
    await view.findByRole('dialog', DIALOG);
    expect(view.queryByTestId('fireworks')).not.toBeNull();
    view.unmount();

    const original = globalThis.matchMedia;
    // A whole MediaQueryList: the rest of the app listens to its own queries on the same function.
    globalThis.matchMedia = ((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    })) as unknown as typeof matchMedia;
    try {
      const calm = await visit({ storage: memoryStorage() });
      await calm.findByRole('dialog', DIALOG);
      expect(calm.queryByTestId('fireworks')).toBeNull();
      calm.unmount();
    } finally {
      globalThis.matchMedia = original;
    }
  });

  test('Escape closes it and remembers the version as the button does', async () => {
    const storage = memoryStorage();
    const view = await visit({ storage });
    await view.findByRole('dialog', DIALOG);
    await person().keyboard('{Escape}');
    await settle();
    expect(isOpen(view)).toBe(false);
    expect(storage.data[RELEASE_NOTES_SEEN_KEY]).toBe('1.0.0');
    view.unmount();
  });

  test('the close button of the window remembers it too', async () => {
    const storage = memoryStorage();
    const view = await visit({ storage });
    await person().click(
      within(await view.findByRole('dialog', DIALOG)).getByRole('button', { name: 'Close' }),
    );
    await settle();
    expect(isOpen(view)).toBe(false);
    expect(storage.data[RELEASE_NOTES_SEEN_KEY]).toBe('1.0.0');
    view.unmount();
  });

  test('a click on the scrim closes it and remembers it', async () => {
    const storage = memoryStorage();
    const view = await visit({ storage });
    const dialog = await view.findByRole('dialog', DIALOG);
    const scrim = dialog.parentElement;
    if (scrim === null) throw new Error('the dialog has no scrim');
    await person().click(scrim);
    await settle();
    expect(isOpen(view)).toBe(false);
    expect(storage.data[RELEASE_NOTES_SEEN_KEY]).toBe('1.0.0');
    view.unmount();
  });

  test('a return to the same version, in a new page of the same browser, never opens it again', async () => {
    const storage = memoryStorage();
    const first = await visit({ storage });
    await person().keyboard('{Escape}');
    await settle();
    first.unmount();

    const again = await visit({ storage });
    expect(isOpen(again)).toBe(false);
    again.unmount();
  });

  test('moving between screens after closing it does not open it again', async () => {
    const storage = memoryStorage();
    const view = await visit({ storage });
    await person().keyboard('{Escape}');
    await settle();
    await act(async () => {
      view.world.history.push('/w/acme/settings/profile');
      await Promise.resolve();
    });
    await settle();
    expect(isOpen(view)).toBe(false);
    view.unmount();
  });

  test('a new version opens it again, with the new version’s notes', async () => {
    const storage = memoryStorage({ [RELEASE_NOTES_SEEN_KEY]: '1.0.0' });
    const view = await visit({ storage, running: '1.1.0' });
    await view.findByRole('dialog', { name: 'What’s new in Purlay 1.1.0' });
    await person().keyboard('{Escape}');
    await settle();
    expect(storage.data[RELEASE_NOTES_SEEN_KEY]).toBe('1.1.0');
    view.unmount();
  });

  test('the version already seen shows nothing', async () => {
    const view = await visit({ storage: memoryStorage({ [RELEASE_NOTES_SEEN_KEY]: '1.0.0' }) });
    expect(isOpen(view)).toBe(false);
    view.unmount();
  });

  test('storage that throws on reading shows nothing, rather than the window at every load', async () => {
    const broken: ClientStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
      key: () => null,
      length: 0,
    };
    const view = await visit({ storage: broken });
    expect(isOpen(view)).toBe(false);
    expect(document.documentElement.dataset['storageFailed']).toContain('release-notes-read');
    view.unmount();
  });

  test('no storage at all shows nothing', async () => {
    const view = await visit({ storage: null });
    expect(isOpen(view)).toBe(false);
    view.unmount();
  });

  test('storage that cannot be written still closes the window, and it stays closed on this page', async () => {
    const full: ClientStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
      key: () => null,
      length: 0,
    };
    const view = await visit({ storage: full });
    await person().keyboard('{Escape}');
    await settle();
    expect(isOpen(view)).toBe(false);
    expect(document.documentElement.dataset['storageFailed']).toContain('release-notes-write');
    view.unmount();
  });

  test('a version the build has no notes for shows nothing and stores nothing', async () => {
    const storage = memoryStorage();
    const view = await visit({ storage, running: '3.0.0' });
    expect(isOpen(view)).toBe(false);
    expect(storage.data[RELEASE_NOTES_SEEN_KEY]).toBeUndefined();
    view.unmount();
  });

  test('a build that carries no notes at all shows nothing', async () => {
    const view = await visit({ notes: null });
    expect(isOpen(view)).toBe(false);
    view.unmount();
  });

  test('notes that fail to load, or are another version’s, or are not notes, show nothing and the app goes on', async () => {
    for (const notes of [
      (): Promise<string | null> => Promise.reject(new Error('chunk gone')),
      (): Promise<string | null> => Promise.resolve('not a release’s notes'),
      (): Promise<string | null> =>
        Promise.resolve('# Purlay v9.9.9 — 2026-10-26\n\n### Added\n\n- **A** — b\n'),
    ] satisfies ReleaseNotesSource[]) {
      const view = await visit({ notes });
      expect(isOpen(view)).toBe(false);
      expect(view.getAllByRole('navigation').length).toBeGreaterThan(0);
      view.unmount();
    }
  });

  test('while the version is still being asked for, nothing is shown and nothing breaks', async () => {
    const view = await visit({ api: { latestRelease: () => new Promise(() => undefined) } });
    expect(isOpen(view)).toBe(false);
    expect(view.getAllByRole('navigation').length).toBeGreaterThan(0);
    view.unmount();
  });

  test('the server not saying its version shows nothing', async () => {
    const view = await visit({
      api: { latestRelease: () => Promise.reject(new Error('no')) },
    });
    expect(isOpen(view)).toBe(false);
    view.unmount();
  });

  test('is not asked for while the version is already seen, so the notes are not even fetched', async () => {
    let fetched = 0;
    const view = await visit({
      storage: memoryStorage({ [RELEASE_NOTES_SEEN_KEY]: '1.0.0' }),
      notes: (wanted) => {
        fetched += 1;
        return notesFor('1.0.0')(wanted);
      },
    });
    expect(fetched).toBe(0);
    view.unmount();
  });

  // The regression this guards: the browser once learned the version from the public `GET /api/client`, which is
  // charged to the address with the sign-in traffic, and every load of the shell spent that budget (D-248).
  test('the shell and About ask for the version from the session’s own route, once, and never for the public client info', async () => {
    const asked: string[] = [];
    const base = aSignedInApi(version('1.0.0'));
    const api = new Proxy(base, {
      get: (target, name): unknown => {
        const member: unknown = Reflect.get(target, name);
        if (typeof member !== 'function' || typeof name !== 'string') return member;
        return (...args: unknown[]): unknown => {
          asked.push(name);
          return Reflect.apply(member, target, args);
        };
      },
    });
    const view = await renderApp(<Outlet />, {
      path: '/w/acme/settings/about',
      api,
      storage: memoryStorage({ [RELEASE_NOTES_SEEN_KEY]: '1.0.0' }),
      releaseNotes: notesFor('1.0.0'),
    });
    await view.findByRole('heading', { level: 1, name: 'About' });
    await settle();
    expect(asked.filter((name) => /client/i.test(name))).toEqual([]);
    expect(asked.filter((name) => name === 'latestRelease')).toHaveLength(1);
    view.unmount();
  });
});
