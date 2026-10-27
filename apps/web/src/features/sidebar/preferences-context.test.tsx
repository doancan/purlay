/**
 * Where a person's sidebar arrangement is kept and how it is read back (D-195): per person and workspace, in the
 * browser, and never worth a failure — a page whose storage refuses, or holds what cannot be read, draws the
 * defaults and goes on arranging the sidebar for as long as it is open.
 */
import { describe, expect, test } from 'bun:test';
import { act, render } from '@testing-library/react';
import { resetStorageNotes, type ClientStorage } from '../../data/browser-storage';
import { StorageProvider } from '../../data/storage-provider';
import { installDom } from '../../testing/dom';
import { memoryStorage } from '../../testing/fakes';
import { person } from '../../testing/user';
import { DEFAULT_PREFERENCES, keyFor, serialisePreferences } from './preferences';
import { SidebarPreferencesProvider, useSidebarPreferences } from './preferences-context';

installDom();

/** Shows what the hook holds, and has a button for each change a person can make. */
const Probe = (): React.JSX.Element => {
  const { preferences, change, reset } = useSidebarPreferences();
  return (
    <div>
      <output aria-label="held">{JSON.stringify(preferences)}</output>
      <button
        type="button"
        onClick={() => {
          change({ unreadOnly: true });
        }}
      >
        unread
      </button>
      <button type="button" onClick={reset}>
        reset
      </button>
    </div>
  );
};

const held = (view: ReturnType<typeof render>): unknown =>
  JSON.parse(view.getByLabelText('held').textContent);

const draw = (
  storage: ClientStorage | null,
  userId = 'user-1',
  workspaceId = 'ws-1',
): ReturnType<typeof render> =>
  render(
    <StorageProvider storage={storage}>
      <SidebarPreferencesProvider
        key={`${userId}.${workspaceId}`}
        userId={userId}
        workspaceId={workspaceId}
      >
        <Probe />
      </SidebarPreferencesProvider>
    </StorageProvider>,
  );

describe('reading what was kept', () => {
  test('with nothing kept, the defaults', () => {
    const view = draw(memoryStorage());
    expect(held(view)).toEqual(DEFAULT_PREFERENCES);
  });

  test('what this person kept for this workspace, and not another’s', () => {
    const mine = { ...DEFAULT_PREFERENCES, unreadOnly: true };
    const storage = memoryStorage({
      [keyFor('user-1', 'ws-1')]: serialisePreferences(mine),
      [keyFor('user-2', 'ws-1')]: serialisePreferences({ ...DEFAULT_PREFERENCES, hideMuted: true }),
      [keyFor('user-1', 'ws-2')]: serialisePreferences({
        ...DEFAULT_PREFERENCES,
        channelOrder: 'activity',
      }),
    });
    expect(held(draw(storage))).toEqual(mine);
  });

  test('what cannot be read is the defaults, and is not an error', () => {
    const view = draw(memoryStorage({ [keyFor('user-1', 'ws-1')]: '{not json' }));
    expect(held(view)).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('keeping a change', () => {
  test('is written under the person’s and the workspace’s key, and reset writes the defaults back', async () => {
    const storage = memoryStorage();
    const view = draw(storage);
    await person().click(view.getByRole('button', { name: 'unread' }));
    expect(JSON.parse(storage.getItem(keyFor('user-1', 'ws-1')) ?? '{}')).toMatchObject({
      unreadOnly: true,
    });
    expect(held(view)).toMatchObject({ unreadOnly: true });

    await person().click(view.getByRole('button', { name: 'reset' }));
    expect(JSON.parse(storage.getItem(keyFor('user-1', 'ws-1')) ?? '{}')).toEqual(
      DEFAULT_PREFERENCES,
    );
  });

  test('moving to another workspace reads that one’s, and coming back finds the first as it was left', async () => {
    const storage = memoryStorage();
    const first = draw(storage, 'user-1', 'ws-1');
    await person().click(first.getByRole('button', { name: 'unread' }));
    first.unmount();

    expect(held(draw(storage, 'user-1', 'ws-2'))).toEqual(DEFAULT_PREFERENCES);
  });

  test('a page with no storage still arranges the sidebar while it is open, and holds nothing after', async () => {
    const view = draw(null);
    await person().click(view.getByRole('button', { name: 'unread' }));
    expect(held(view)).toMatchObject({ unreadOnly: true });
    view.unmount();
    expect(held(draw(null))).toEqual(DEFAULT_PREFERENCES);
  });

  test('storage that refuses to be read or written leaves a note on the page and does not break it', async () => {
    resetStorageNotes();
    const refusing: ClientStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
      key: () => null,
      length: 0,
    };
    const view = draw(refusing);
    expect(held(view)).toEqual(DEFAULT_PREFERENCES);
    await act(async () => {
      await person().click(view.getByRole('button', { name: 'unread' }));
    });
    expect(held(view)).toMatchObject({ unreadOnly: true });
    const notes = document.documentElement.dataset['storageFailed'] ?? '';
    expect(notes).toContain('sidebar-read');
    expect(notes).toContain('sidebar-write');
    resetStorageNotes();
  });
});

describe('with no provider above it', () => {
  test('the hook gives the defaults and changes nothing, so a section drawn alone needs none', async () => {
    const view = render(<Probe />);
    expect(held(view)).toEqual(DEFAULT_PREFERENCES);
    await person().click(view.getByRole('button', { name: 'unread' }));
    expect(held(view)).toEqual(DEFAULT_PREFERENCES);
  });
});
