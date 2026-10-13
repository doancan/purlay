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

const first = aMessage(1, { content: 'keep this one' });

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

const saveButton = (view: Awaited<ReturnType<typeof mountChannel>>): HTMLElement =>
  view.getByRole('button', { name: /^(Save for later|Remove from saved)$/ });

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
    expect(saveButton(view).getAttribute('aria-label')).toBe('Remove from saved');
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
    view.unmountAll();
  });
});
