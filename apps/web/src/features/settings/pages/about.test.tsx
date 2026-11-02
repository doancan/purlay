/**
 * About (D-248), through the real frame against the fake API: the version the server runs, the newest release and
 * the sentence that compares them in each of its four cases, loading and a failure with Retry, the release notes
 * of the running version, the licence and the repository — in both languages.
 */
import { describe, expect, test } from 'bun:test';
import { act, waitFor, within } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import type { LatestReleaseAnswer } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { memoryStorage } from '../../../testing/fakes';
import { aSignedInApi } from '../../../testing/fixtures';
import { notesFor } from '../../../testing/release-notes';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { RELEASE_NOTES_SEEN_KEY } from '../../about/release-notes-once';
import type { ReleaseNotesSource } from '../../about/release-notes-source';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

type View = Awaited<ReturnType<typeof renderApp>>;

/** What `within` answers: the queries, bound to one part of the page. */
type Scope = BoundFunctions<typeof queries>;

/** What the server answers: the version it runs, and the newest release it learned of, if it did. */
const answer = (current: string, newest: string | null): LatestReleaseAnswer => ({
  current,
  latest:
    newest === null
      ? null
      : {
          version: newest,
          url: `https://github.com/doancan/purlay/releases/tag/v${newest}`,
          publishedAt: '2026-10-30T08:00:00.000Z',
        },
});

const open = async (
  api: Partial<Api>,
  options: {
    locale?: 'en' | 'tr';
    releaseNotes?: ReleaseNotesSource;
    storage?: ReturnType<typeof memoryStorage>;
  } = {},
): Promise<View> => {
  const {
    locale = 'en',
    releaseNotes,
    storage = memoryStorage({ [RELEASE_NOTES_SEEN_KEY]: '0.1.0' }),
  } = options;
  const view = await renderApp(<Outlet />, {
    path: '/w/acme/settings/about',
    locale,
    ...(releaseNotes === undefined ? {} : { releaseNotes }),
    // The window that opens once after an update has been seen: this is the page that reopens it by hand.
    storage,
    api: aSignedInApi(api),
  });
  await view.findByRole('heading', { level: 1, name: locale === 'en' ? 'About' : 'Hakkında' });
  await settle();
  return view;
};

const versions = (view: View): Scope => within(view.getByRole('region', { name: 'Version' }));

describe('the About page', () => {
  test('up to date: both versions, the release’s date and page, and a sentence that says so', async () => {
    const view = await open({
      latestRelease: () => Promise.resolve(answer('0.1.0', '0.1.0')),
    });
    const card = versions(view);
    expect(card.getByText('This server runs')).toBeDefined();
    expect(card.getAllByText('0.1.0')).toHaveLength(2);
    expect(card.getByText('Published Oct 30, 2026')).toBeDefined();
    const link = card.getByRole('link', { name: /View release on GitHub/ });
    expect(link.getAttribute('href')).toBe('https://github.com/doancan/purlay/releases/tag/v0.1.0');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(card.getByRole('status').textContent).toBe('You are up to date.');
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('a newer release exists: it is named, in the warning tone', async () => {
    const view = await open({
      latestRelease: () => Promise.resolve(answer('0.1.0', '0.2.0')),
    });
    const status = versions(view).getByRole('status');
    expect(status.textContent).toBe('Version 0.2.0 is available.');
    expect(status.className).toContain('text-warning-text');
    view.unmount();
  });

  test('a server newer than the newest release, as a build ahead of its tag is, is up to date', async () => {
    const view = await open({
      latestRelease: () => Promise.resolve(answer('0.10.0', '0.9.9')),
    });
    expect(versions(view).getByRole('status').textContent).toBe('You are up to date.');
    view.unmount();
  });

  test('could not check: the newest is unknown, and the sentence says why it can be', async () => {
    const view = await open({
      latestRelease: () => Promise.resolve(answer('0.1.0', null)),
    });
    const card = versions(view);
    expect(card.getByText('Unknown')).toBeDefined();
    expect(card.getByRole('status').textContent).toMatch(/^Could not check for a newer version/);
    expect(card.queryByRole('link')).toBeNull();
    view.unmount();
  });

  test('a refused request is an error with Retry, told apart from a deliberate "could not check", and not retried on its own', async () => {
    let asked = 0;
    const view = await open({
      latestRelease: () => {
        asked += 1;
        return asked === 1
          ? Promise.reject(new ApiError(429, 'RATE_LIMITED', 'slow down'))
          : Promise.resolve(answer('0.1.0', '0.2.0'));
      },
    });
    const card = versions(view);
    expect(card.getByRole('alert').textContent).toContain('Could not load the version');
    expect(card.queryByText('Unknown')).toBeNull();
    expect(card.queryByRole('status')).toBeNull();
    expect(asked).toBe(1);
    await person().click(card.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(asked).toBe(2);
    expect(card.queryByRole('alert')).toBeNull();
    expect(card.getByText('0.1.0')).toBeDefined();
    expect(card.getByRole('status').textContent).toBe('Version 0.2.0 is available.');
    view.unmount();
  });

  test('a version that is not three numbers cannot be compared, and says it could not check', async () => {
    const view = await open({
      latestRelease: () => Promise.resolve(answer('dev', '0.2.0')),
    });
    expect(versions(view).getByRole('status').textContent).toMatch(/^Could not check/);
    view.unmount();
  });

  test('loading: a labelled status while the version and the newest release are asked for', async () => {
    const view = await renderApp(<Outlet />, {
      path: '/w/acme/settings/about',
      api: aSignedInApi({
        latestRelease: () => new Promise(() => undefined),
      }),
    });
    await view.findByRole('heading', { level: 1, name: 'About' });
    await settle();
    expect(versions(view).getByRole('status').textContent).toBe('Loading');
    view.unmount();
  });

  test('the licence and the repository are always there, and open GitHub in another tab', async () => {
    const view = await open({
      latestRelease: () => Promise.reject(new ApiError(500, 'INTERNAL', 'no')),
    });
    const card = within(view.getByRole('region', { name: 'Open source' }));
    expect(card.getByText('AGPL-3.0-or-later')).toBeDefined();
    const repository = card.getByRole('link', {
      name: (name) => name.includes('github.com/doancan/purlay'),
    });
    expect(repository.getAttribute('href')).toBe('https://github.com/doancan/purlay');
    expect(repository.getAttribute('target')).toBe('_blank');
    expect(repository.textContent).toContain('github.com/doancan/purlay');
    // Its name is what it shows (WCAG 2.5.3), and it says it opens a new tab.
    expect(repository.getAttribute('aria-label')).toBeNull();
    expect(repository.textContent).toContain('Opens in a new tab');
    view.unmount();
  });

  test('What’s new opens the notes of the running version; Escape closes it, and what the browser remembers is not touched', async () => {
    const storage = memoryStorage({ [RELEASE_NOTES_SEEN_KEY]: '0.1.0' });
    const view = await open(
      {
        latestRelease: () => Promise.resolve(answer('0.1.0', '0.1.0')),
      },
      { releaseNotes: notesFor('0.1.0'), storage },
    );
    expect(view.queryByRole('dialog') !== null).toBe(false);
    await person().click(await view.findByRole('button', { name: 'What’s new' }));
    const dialog = await view.findByRole('dialog', { name: 'What’s new in Purlay 0.1.0' });
    expect(within(dialog).getByText('Released Oct 26, 2026.')).toBeDefined();
    expect(within(dialog).getByRole('heading', { level: 3, name: 'Added' })).toBeDefined();
    expect(within(dialog).getByText('Messages').tagName).toBe('STRONG');
    expect(within(dialog).getByText('day dividers').tagName).toBe('CODE');
    await person().keyboard('{Escape}');
    await waitFor(() => {
      expect(view.queryByRole('dialog') !== null).toBe(false);
    });
    expect(storage.data[RELEASE_NOTES_SEEN_KEY]).toBe('0.1.0');
    view.unmount();
  });

  test('a version the build has no notes for has no What’s new', async () => {
    const view = await open(
      {
        latestRelease: () => Promise.resolve(answer('0.1.0', '0.1.0')),
      },
      { releaseNotes: notesFor('9.9.9') },
    );
    expect(view.queryByRole('button', { name: 'What’s new' })).toBeNull();
    view.unmount();
  });

  test('in Turkish, the page and the sentence are in Turkish', async () => {
    const view = await open(
      {
        latestRelease: () => Promise.resolve(answer('0.1.0', '0.2.0')),
      },
      { locale: 'tr', releaseNotes: notesFor('0.1.0') },
    );
    expect(view.getByText('0.2.0 sürümü yayımlandı.')).toBeDefined();
    expect(await view.findByRole('button', { name: 'Yenilikler' })).toBeDefined();
    view.unmount();
  });
});
