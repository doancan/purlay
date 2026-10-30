/**
 * Links to messages, as cards (D-217): which links are cards, and that a card shows only what its
 * reader may see — the message when the server gives it, and nothing of it when the server refuses.
 */
import { describe, expect, test } from 'bun:test';
import { installDom } from '../../testing/dom';
import { BOB, IDS, aMessage, messageIdAt } from '../../testing/fixtures';
import { mountChannel, page } from '../../testing/channel-harness';
import { ApiError } from '../../data/errors';
import { linkedMessages } from './message-cards';

installDom();

const ORIGIN = 'https://purlay.test';

describe('which links are cards', () => {
  test('a message of this workspace on this origin, by ?message= or ?thread=, each once, three at most', () => {
    const content = [
      `${ORIGIN}/w/acme/c/c1?message=m1`,
      `again ${ORIGIN}/w/acme/c/c1?message=m1`,
      `${ORIGIN}/w/acme/c/c2?thread=m2`,
      `${ORIGIN}/w/other/c/c3?message=m3`,
      `https://elsewhere.test/w/acme/c/c4?message=m4`,
      `${ORIGIN}/w/acme/c/c5`,
      `${ORIGIN}/w/acme/c/c6?message=m6 and ${ORIGIN}/w/acme/c/c7?message=m7`,
    ].join('\n');
    expect(linkedMessages(content, ORIGIN, 'acme')).toEqual(['m1', 'm2', 'm6']);
  });
});

const linking = (target: string): string =>
  `${window.location.origin}/w/acme/c/${IDS.api}?message=${target}`;

describe('a card', () => {
  test('shows who wrote it and the start of what they wrote', async () => {
    const original = aMessage(1, { sender: BOB, content: 'Pool size is 20 now.' });
    const view = await mountChannel({
      messages: page([aMessage(2, { content: `see this\n\n${linking(original.id)}` })]),
      api: { message: () => Promise.resolve(original) },
    });
    const card = await view.findByRole('button', { name: /Pool size is 20 now\./ });
    expect(card.textContent).toContain(BOB.displayName);
    view.unmountAll();
  });

  test('a message the reader may not see is said to be unavailable, and nothing of it is drawn', async () => {
    const view = await mountChannel({
      messages: page([aMessage(2, { content: linking(messageIdAt(1)) })]),
      api: {
        message: () => Promise.reject(new ApiError(404, 'MESSAGE_NOT_FOUND', 'Message not found.')),
      },
    });
    expect(await view.findByText('This message is not available to you.')).toBeDefined();
    view.unmountAll();
  });
});
