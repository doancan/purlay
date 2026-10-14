/**
 * Save on a message (#484, D-128), as a person meets it in a channel: marked at once, kept by the
 * server, put back and said — with Retry — when the server refuses; and a saved message is shown
 * saved, and let go the same way.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { mountChannel, page, settle } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { IDS, aMessage, messageIdAt } from '../../testing/fixtures';
import { person } from '../../testing/user';

installDom();

/** A server whose list of saves is what was saved and let go. */
const aServer = (
  saved: string[] = [],
): {
  readonly saved: string[];
  readonly savedIds: () => Promise<
    { messageId: string; channelId: string; state: 'in_progress' }[]
  >;
} => ({
  saved,
  savedIds: () =>
    Promise.resolve(
      saved.map((messageId) => ({ messageId, channelId: IDS.api, state: 'in_progress' as const })),
    ),
});

const first = aMessage(1, { content: 'keep this one' });
const second = aMessage(2, { content: 'and this one' });

/** One name whatever its state: the state is `aria-pressed`, never a second name (#558). */
const saveButton = (view: Awaited<ReturnType<typeof mountChannel>>, at = 0): HTMLElement => {
  const button = view.getAllByRole('button', { name: 'Save for later' })[at];
  if (button === undefined) throw new Error(`no Save at ${String(at)}`);
  return button;
};

/** A promise the test settles when it says. */
const deferred = (): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
} => {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe('saving a message', () => {
  test('is marked at once, before the server answers, and the server is asked once', async () => {
    const asked: string[] = [];
    const view = await mountChannel({
      messages: page([first]),
      api: {
        saveMessage: (messageId) => {
          asked.push(messageId);
          return new Promise(() => undefined);
        },
      },
    });
    const button = saveButton(view);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    await person().click(button);
    expect(saveButton(view).getAttribute('aria-pressed')).toBe('true');
    expect(saveButton(view).getAttribute('aria-busy')).toBe('true');
    expect(saveButton(view).getAttribute('title')).toBe('Remove from saved');
    // A press while it is on its way is not a second request, and does not undo the first.
    await person().click(saveButton(view));
    expect(saveButton(view).getAttribute('aria-pressed')).toBe('true');
    expect(asked).toEqual([messageIdAt(1)]);
    await expectNoAxeViolations(view.container);
    view.unmountAll();
  });

  test('a saved message is shown saved, and let go the same way', async () => {
    const letGo: string[] = [];
    const server = aServer([messageIdAt(1)]);
    const view = await mountChannel({
      messages: page([first]),
      api: {
        savedIds: server.savedIds,
        unsaveMessage: (messageId) => {
          letGo.push(messageId);
          server.saved.splice(server.saved.indexOf(messageId), 1);
          return Promise.resolve();
        },
      },
    });
    expect(saveButton(view).getAttribute('aria-pressed')).toBe('true');
    await person().click(saveButton(view));
    await settle();
    expect(saveButton(view).getAttribute('aria-pressed')).toBe('false');
    expect(letGo).toEqual([messageIdAt(1)]);
    view.unmountAll();
  });

  test('refused, it is put back and said, and Retry tries again', async () => {
    let refuse = true;
    const asked: string[] = [];
    const server = aServer();
    const view = await mountChannel({
      messages: page([first]),
      api: {
        savedIds: server.savedIds,
        saveMessage: (messageId) => {
          asked.push(messageId);
          if (refuse) return Promise.reject(new ApiError(0, 'NETWORK', 'offline'));
          server.saved.push(messageId);
          return Promise.resolve();
        },
      },
    });
    await person().click(saveButton(view));
    await settle();
    expect(saveButton(view).getAttribute('aria-pressed')).toBe('false');
    expect(view.getByText(/^The message was not saved\./)).toBeDefined();
    refuse = false;
    await act(async () => {
      await person().click(view.getByRole('button', { name: 'Retry' }));
    });
    await settle();
    expect(asked).toEqual([messageIdAt(1), messageIdAt(1)]);
    expect(saveButton(view).getAttribute('aria-pressed')).toBe('true');
    view.unmountAll();
  });

  test('at the bound, the server’s words say what to do', async () => {
    const view = await mountChannel({
      messages: page([first]),
      api: {
        saveMessage: () => Promise.reject(new ApiError(409, 'SAVED_LIMIT', 'full')),
      },
    });
    await person().click(saveButton(view));
    await settle();
    expect(view.getByText(/That is as many saved messages as a workspace keeps\./)).toBeDefined();
    // Trying again would fail the same way: nothing offers to.
    expect(view.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(saveButton(view).getAttribute('aria-pressed')).toBe('false');
    view.unmountAll();
  });

  test('a refusal takes back only its own save; a read while one is on its way keeps its mark', async () => {
    const server = aServer();
    const held = deferred();
    const view = await mountChannel({
      messages: page([first, second]),
      api: {
        savedIds: server.savedIds,
        saveMessage: async (messageId) => {
          if (messageId === messageIdAt(1)) {
            await held.promise;
            return;
          }
          server.saved.push(messageId);
          await Promise.resolve();
        },
      },
    });
    await person().click(saveButton(view, 0));
    await person().click(saveButton(view, 1));
    await settle();
    // The second save landed and the list was read again — without the first, still on its way.
    expect(saveButton(view, 1).getAttribute('aria-pressed')).toBe('true');
    expect(saveButton(view, 0).getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      held.reject(new ApiError(0, 'NETWORK', 'offline'));
      await Promise.resolve();
    });
    await settle();
    // Refused: the first goes back; the second, which the server has, stays.
    expect(saveButton(view, 0).getAttribute('aria-pressed')).toBe('false');
    expect(saveButton(view, 1).getAttribute('aria-pressed')).toBe('true');
    view.unmountAll();
  });

  test('Retry asks again only for what is still not so', async () => {
    const asked: string[] = [];
    const server = aServer();
    const view = await mountChannel({
      messages: page([first, second]),
      api: {
        savedIds: server.savedIds,
        saveMessage: (messageId) => {
          asked.push(messageId);
          if (messageId === messageIdAt(1) && asked.length === 1) {
            return Promise.reject(new ApiError(0, 'NETWORK', 'offline'));
          }
          server.saved.push(messageId);
          return Promise.resolve();
        },
      },
    });
    await person().click(saveButton(view, 0));
    await settle();
    expect(saveButton(view, 0).getAttribute('aria-pressed')).toBe('false');
    // Meanwhile another tab saved it, and a read brought that here.
    server.saved.push(messageIdAt(1));
    await person().click(saveButton(view, 1));
    await settle();
    expect(saveButton(view, 0).getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      await person().click(view.getByRole('button', { name: 'Retry' }));
    });
    await settle();
    expect(asked).toEqual([messageIdAt(1), messageIdAt(2)]);
    view.unmountAll();
  });

  test('saved, the mark holds until the list is read again; a read that fails keeps the change', async () => {
    let reads = 0;
    const reread = deferred();
    const view = await mountChannel({
      messages: page([first]),
      api: {
        savedIds: async () => {
          reads += 1;
          if (reads === 2) await reread.promise;
          return [];
        },
        saveMessage: () => Promise.resolve(),
      },
    });
    await person().click(saveButton(view));
    await settle();
    // Saved, and the list being read again: still marked, still on its way.
    expect(reads).toBe(2);
    expect(saveButton(view).getAttribute('aria-pressed')).toBe('true');
    expect(saveButton(view).getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      reread.reject(new ApiError(0, 'NETWORK', 'offline'));
      await Promise.resolve();
    });
    await settle();
    // The read failed, the save did not: it stays marked, and nothing says it was refused.
    expect(saveButton(view).getAttribute('aria-pressed')).toBe('true');
    expect(saveButton(view).getAttribute('aria-busy')).toBe('false');
    expect(view.queryByText(/^The message was not saved\./)).toBeNull();
    view.unmountAll();
  });
});
