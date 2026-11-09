import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { installDom } from '../../testing/dom';
import { renderApp } from '../../testing/render';
import { memoryStorage, storageChanged } from '../../testing/fakes';
import { resetStorageNotes } from '../../data/browser-storage';
import { person } from '../../testing/user';
import { AlertPreferencesProvider, ChimeContext, useAlertPreferences } from './preferences-context';

installDom();

const Controls = (): React.JSX.Element => {
  const { change, play, preview, remembered, preferences, audio } = useAlertPreferences();
  return (
    <>
      <button
        onClick={() => {
          play();
        }}
      >
        Play
      </button>
      <button onClick={preview}>Preview</button>
      <button
        onClick={() => {
          change({ sound: false });
        }}
      >
        Mute
      </button>
      <span>{remembered ? 'Remembered' : 'This page only'}</span>
      <span>{preferences.sound ? 'Sound on' : 'Sound off'}</span>
      <span>{audio}</span>
    </>
  );
};

describe('personal alert controls', () => {
  test('controls outside a signed-in session remain unavailable and temporary', async () => {
    const view = await renderApp(<Controls />);
    await person().click(view.getByRole('button', { name: 'Play' }));
    await person().click(view.getByRole('button', { name: 'Preview' }));
    await person().click(view.getByRole('button', { name: 'Mute' }));
    expect(view.getByText('unavailable')).toBeTruthy();
    expect(view.getByText('This page only')).toBeTruthy();
    expect(view.getByText('Sound on')).toBeTruthy();
    view.unmount();
  });
  test('an unreadable preference falls back safely and records why', async () => {
    resetStorageNotes();
    const storage = memoryStorage();
    storage.setItem('purlay.person', 'alice');
    const view = await renderApp(
      <ChimeContext.Provider value={null}>
        <AlertPreferencesProvider userId="alice">
          <Controls />
        </AlertPreferencesProvider>
      </ChimeContext.Provider>,
      {
        storage: {
          ...storage,
          getItem: (key): string | null => {
            if (key.startsWith('purlay.push.preferences.')) throw new Error('Blocked');
            return storage.getItem(key);
          },
        },
      },
    );
    expect(view.getByText('Sound on')).toBeTruthy();
    expect(document.documentElement.dataset['storageFailed']).toContain('alert-read');
    view.unmount();
  });
  test('without storage a changed choice remains local and visibly temporary', async () => {
    const view = await renderApp(
      <ChimeContext.Provider value={null}>
        <AlertPreferencesProvider userId="alice">
          <Controls />
        </AlertPreferencesProvider>
      </ChimeContext.Provider>,
      { storage: null },
    );
    await person().click(view.getByRole('button', { name: 'Mute' }));
    expect(view.getByText('Sound off')).toBeTruthy();
    expect(view.getByText('This page only')).toBeTruthy();
    view.unmount();
  });
  test('sound opt-out, logout and a pending preview cannot play another person’s sound', async () => {
    const storage = memoryStorage();
    storage.setItem('purlay.person', 'alice');
    const played: number[] = [];
    let resume: ((ready: boolean) => void) | undefined;
    let stopped = 0;
    const view = await renderApp(
      <ChimeContext.Provider
        value={{
          unlock: () =>
            new Promise((resolve) => {
              resume = resolve;
            }),
          play: (volume): boolean => {
            played.push(volume);
            return true;
          },
          stop: (): void => {
            stopped += 1;
          },
          dispose: () => undefined,
        }}
      >
        <AlertPreferencesProvider userId="alice">
          <Controls />
        </AlertPreferencesProvider>
      </ChimeContext.Provider>,
      { storage },
    );
    await person().click(view.getByRole('button', { name: 'Play' }));
    expect(played).toEqual([50]);
    await person().click(view.getByRole('button', { name: 'Mute' }));
    await person().click(view.getByRole('button', { name: 'Play' }));
    expect(played).toEqual([50]);
    await person().click(view.getByRole('button', { name: 'Preview' }));
    act(() => {
      storage.setItem('purlay.person', 'bob');
      storageChanged('purlay.person');
    });
    await act(async () => {
      resume?.(true);
      await Promise.resolve();
    });
    await person().click(view.getByRole('button', { name: 'Play' }));
    expect(played).toEqual([50]);
    expect(stopped).toBeGreaterThan(0);
    view.unmount();
  });
  test('a refused storage write leaves a visible temporary preference', async () => {
    const storage = memoryStorage();
    storage.setItem('purlay.person', 'alice');
    const view = await renderApp(
      <AlertPreferencesProvider userId="alice">
        <Controls />
      </AlertPreferencesProvider>,
      {
        storage: {
          ...storage,
          setItem: () => {
            throw new Error('Quota exceeded');
          },
        },
      },
    );
    await person().click(view.getByRole('button', { name: 'Mute' }));
    expect(view.getByText('This page only')).toBeTruthy();
    view.unmount();
  });
});
