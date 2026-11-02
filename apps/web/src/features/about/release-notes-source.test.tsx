/**
 * Where the notes come from (D-248): a version with no file is *no notes*, kept; a source that fails to look is
 * not an answer — it is reported on the page and tried again, never remembered as "there are none".
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { resetStorageNotes } from '../../data/browser-storage';
import { installDom } from '../../testing/dom';
import { notesFor } from '../../testing/release-notes';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { useReleaseNotes, type ReleaseNotesSource } from './release-notes-source';

installDom();

const Probe = ({ version }: { readonly version: string }): React.JSX.Element => {
  const query = useReleaseNotes(version);
  const words = query.isError
    ? 'failed'
    : query.data === undefined
      ? 'unknown'
      : query.data === null
        ? 'none'
        : `notes ${query.data.version}`;
  return (
    <button
      type="button"
      onClick={() => {
        void query.refetch();
      }}
    >
      {words}
    </button>
  );
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

describe('the notes of a version', () => {
  test('a version with no file is none, and a version with one is its notes', async () => {
    const source = notesFor('1.0.0');
    const none = await renderApp(<Probe version="2.0.0" />, { releaseNotes: source });
    await settle();
    expect(none.getByRole('button').textContent).toBe('none');
    none.unmount();
    const some = await renderApp(<Probe version="1.0.0" />, { releaseNotes: source });
    await settle();
    expect(some.getByRole('button').textContent).toBe('notes 1.0.0');
    some.unmount();
  });

  test('a source that fails is an error, not "none": it is reported, and asked again', async () => {
    resetStorageNotes();
    let asked = 0;
    const flaky: ReleaseNotesSource = async (version) => {
      asked += 1;
      if (asked === 1) return await Promise.reject(new Error('chunk gone after a redeploy'));
      return await notesFor('1.0.0')(version);
    };
    const view = await renderApp(<Probe version="1.0.0" />, { releaseNotes: flaky });
    await settle();
    expect(view.getByRole('button').textContent).toBe('failed');
    expect(document.documentElement.dataset['storageFailed']).toContain('release-notes-load');

    await person().click(view.getByRole('button'));
    await settle();
    expect(view.getByRole('button').textContent).toBe('notes 1.0.0');
    expect(asked).toBe(2);
    view.unmount();
  });
});
