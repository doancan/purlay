/**
 * Code references in a channel's feed (D-223): links into the channel's one GitHub feed repository,
 * as the channel list says it, and none when it says none — no feed, or several. The detection
 * itself is `@purlay/markdown`'s (`code-references.test.ts`); this is what reaches the screen.
 */
import { describe, expect, test } from 'bun:test';
import { within } from '@testing-library/react';
import { expectNoAxeViolations } from '../../testing/axe';
import { expectFocusOn } from '../../testing/focus';
import { mountChannel, page, type ChannelView } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { IDS, aChannel, aMessage } from '../../testing/fixtures';
import { person } from '../../testing/user';

installDom();

const WORDS = [
  'Retries fail at src/retry.ts:14 — see `retry.test.ts`, fixed in abc1234. Saat 10:30, v1.2.3.',
  '',
  '```ts',
  "import { retry } from './src/retry.ts:14';",
  '```',
].join('\n');

const inChannel = async (codeRepository: string | null, locale?: 'tr'): Promise<ChannelView> =>
  await mountChannel({
    channels: [aChannel(IDS.api, 'api', { codeRepository })],
    messages: page([aMessage(1, { content: WORDS })]),
    ...(locale === undefined ? {} : { locale }),
  });

const references = (view: ChannelView): HTMLAnchorElement[] => [
  ...view.container.querySelectorAll<HTMLAnchorElement>('a[data-code-reference]'),
];

describe('a channel with one feed repository', () => {
  test('links each reference in prose and inline code into it, and nothing in a fenced block', async () => {
    const view = await inChannel('acme/api');
    const links = references(view);
    expect(links.map((link) => [link.querySelector('bdi')?.textContent, link.href])).toEqual([
      ['src/retry.ts:14', 'https://github.com/acme/api/blob/HEAD/src/retry.ts#L14'],
      [
        'retry.test.ts',
        'https://github.com/search?q=repo%3Aacme%2Fapi%20path%3Aretry.test.ts&type=code',
      ],
      ['abc1234', 'https://github.com/acme/api/commit/abc1234'],
    ]);
    // The inline code stays code, with its link inside it.
    expect(links[1]?.closest('code')).not.toBeNull();
    // The fence is code to read and copy: nothing in it is a link.
    const block = view.container.querySelector('pre');
    expect(block?.textContent).toContain('./src/retry.ts:14');
    expect(block?.querySelector('a')).toBeNull();
    for (const link of links) {
      // A new tab, without the referrer; underlined, so not by colour alone (`UX.md` §9); and said.
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');
      expect(link.className).toContain('underline');
      expect(link.title).toBe('Opens github.com');
      expect(link.textContent).toContain('(Opens in a new tab)');
    }
    await expectNoAxeViolations(view.container);
    view.unmountAll();
  });

  test('each is a stop for the keyboard, in reading order', async () => {
    const view = await inChannel('acme/api');
    const [first, second, third] = references(view);
    expect(third).toBeDefined();
    first?.focus();
    expectFocusOn(first ?? null);
    await person().tab();
    expectFocusOn(second ?? null);
    await person().tab();
    expectFocusOn(third ?? null);
    view.unmountAll();
  });

  test('in Turkish, the link says so in Turkish', async () => {
    const view = await inChannel('acme/api', 'tr');
    const [first] = references(view);
    expect(first?.title).toBe('github.com adresini açar');
    expect(first?.textContent).toContain('(Yeni sekmede açılır)');
    view.unmountAll();
  });
});

describe('a channel with no repository — no feed, or several', () => {
  test('links nothing the words did not link, and draws the same words', async () => {
    const view = await inChannel(null);
    expect(references(view)).toEqual([]);
    const body = view.container.querySelector('[data-message-body]');
    expect(
      within(body as HTMLElement).getByText(/Retries fail at src\/retry\.ts:14/),
    ).toBeDefined();
    expect(body?.querySelector('a')).toBeNull();
    view.unmountAll();
  });
});
