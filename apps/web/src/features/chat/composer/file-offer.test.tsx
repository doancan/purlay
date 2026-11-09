/**
 * Answering the offer a long paste leaves (D-259) when the box is not as the paste left it: the offer
 * is held with where its words were, and a later edit may have moved them, or taken them out.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { ATTACHMENT_BYTES_MAX } from '@purlay/types';
import { installDom } from '../../../testing/dom';
import { renderApp } from '../../../testing/render';
import { Toaster } from '../../../ui/toast';
import { useFileOffer, type FileOfferState, type PendingOffer } from './file-offer';

installDom();

const offered = (words: string, at: number): PendingOffer => ({
  file: { name: 'pasted.txt', type: 'text/plain', text: words, lines: 600 },
  words,
  at,
  table: false,
});

const mountOffer = async (
  boxText: string,
  attached = 0,
): Promise<{
  readonly state: () => FileOfferState;
  readonly changes: string[];
  readonly added: File[];
  readonly view: Awaited<ReturnType<typeof renderApp>>;
}> => {
  const changes: string[] = [];
  const added: File[] = [];
  let current: FileOfferState | null = null;
  const latest = { current: boxText };
  const Probe = (): null => {
    current = useFileOffer({
      text: boxText,
      latest,
      caret: { current: null },
      field: { current: null },
      change: (next) => {
        changes.push(next);
      },
      attached,
      addFiles: (files) => {
        added.push(...files);
      },
    });
    return null;
  };
  const view = await renderApp(
    <>
      <Probe />
      <Toaster dismissLabel="Close" />
    </>,
  );
  return {
    state: (): FileOfferState => {
      if (current === null) throw new Error('not rendered');
      return current;
    },
    changes,
    added,
    view,
  };
};

describe('answering an offer after the box was edited', () => {
  test('words that moved are found where they are now, and only they are taken out', async () => {
    const words = 'one\ntwo';
    const { state, changes, added } = await mountOffer(`typed first\n\n${words}`);
    act(() => {
      state().accept(offered(words, 0));
    });
    expect(changes).toEqual(['typed first\n\n']);
    expect(added.map((file) => file.name)).toEqual(['pasted.txt']);
  });

  test('words that are no longer there stay unoffered, and the person is told', async () => {
    const { state, changes, added, view } = await mountOffer('something else');
    act(() => {
      state().accept(offered('one\ntwo', 0));
    });
    expect(view.getByText('The pasted text changed, so it stays in the message.')).toBeDefined();
    expect(changes).toEqual([]);
    expect(added).toEqual([]);
  });

  test('a file larger than a message may carry is refused in words, and the words stay', async () => {
    const { state, changes, added, view } = await mountOffer('one\ntwo');
    const huge: PendingOffer = {
      ...offered('one\ntwo', 0),
      file: {
        name: 'huge.txt',
        type: 'text/plain',
        text: 'x'.repeat(ATTACHMENT_BYTES_MAX + 1),
        lines: 1,
      },
    };
    act(() => {
      state().accept(huge);
    });
    expect(view.getByText(/larger than a file may be \(25 MB\)/)).toBeDefined();
    expect(changes).toEqual([]);
    expect(added).toEqual([]);
  });
});
