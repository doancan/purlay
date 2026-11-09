import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { installDom } from '../../testing/dom';
import { renderApp } from '../../testing/render';
import { memoryStorage } from '../../testing/fakes';
import { person } from '../../testing/user';
import { AlertPreferencesProvider, ChimeContext, useAlertPreferences } from './preferences-context';

installDom();

const Controls = (): React.JSX.Element => {
  const { change, play, preview, remembered } = useAlertPreferences();
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
    </>
  );
};

describe('personal alert controls', () => {
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
      window.dispatchEvent(new StorageEvent('storage', { key: 'purlay.person' }));
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
