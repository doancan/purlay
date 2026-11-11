/**
 * The box people write in (`UX.md` §5, D-99 §3): what Enter does in each situation, what a
 * paste becomes, what survives a switch or a reload, what is refused before it leaves, and what
 * happens to a send when the network is not there. The composer is never disabled — the one
 * promise that makes a bad connection bearable — and the offline test is where that is held.
 *
 * Every test has a room of its own (`support.ts`); what "sent" means is read from the server.
 */
import type { Locator, Page, WebSocketRoute } from '@playwright/test';
import { Value } from '@sinclair/typebox/value';
import { MeResponse } from '@purlay/types';
import { expect, test } from './fixtures';
import { navLink, onEngine } from './support';

const boxOf = (page: Page, name: string): Locator =>
  page.getByRole('textbox', { name: `Message ${name}` });

const rowWith = (page: Page, text: string): Locator =>
  page.locator('[data-message-row]', { hasText: text });

/** A row the server has accepted: on the screen, not still sending, not failed. */
const expectDelivered = async (page: Page, text: string): Promise<void> => {
  const row = rowWith(page, text);
  await expect(row).toBeVisible();
  await expect(row.getByRole('img', { name: 'Sending' })).toHaveCount(0);
  if ((await row.getByText('Failed to send').count()) > 0) {
    throw new Error(`the send failed: ${await row.innerText()}`);
  }
};

interface Stored {
  readonly data: readonly { readonly content: string }[];
}

/** What the server holds in the room, newest first, as plain strings. */
const stored = async (get: <T>(path: string) => Promise<T>, roomId: string): Promise<string[]> =>
  (await get<Stored>(`/api/channels/${roomId}/messages?limit=100`)).data.map((m) => m.content);

test.describe('Enter', () => {
  test('sends, Shift+Enter adds a line, and the line break arrives as a line break', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    await box.fill('first line');
    await box.press('Shift+Enter');
    await box.pressSequentially('second line');
    await expect(box).toHaveValue('first line\nsecond line');
    await box.press('Enter');
    await expect(box).toHaveValue('');
    await expectDelivered(page, 'second line');
    await expect(box).toBeFocused();
    expect(await stored((path) => api('dogancan').get(path), made.id)).toEqual([
      'first line\nsecond line',
    ]);
  });

  test('inside a code fence is a new line; the closing fence and Enter send; ⌘/Ctrl+Enter sends from anywhere', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    await box.fill('```ts');
    await box.press('Enter');
    await box.pressSequentially('const answer = 42;');
    await box.press('Enter');
    // Still writing: nothing has been sent.
    await expect(box).toHaveValue('```ts\nconst answer = 42;\n');
    expect(await stored((path) => api('dogancan').get(path), made.id)).toEqual([]);
    await box.pressSequentially('```');
    await box.press('Enter');
    await expect(box).toHaveValue('');
    await expect(page.locator('pre', { hasText: 'const answer = 42;' })).toBeVisible();

    // Open fence, and the chord sends anyway.
    await box.fill('```\nunfinished');
    await box.press('ControlOrMeta+Enter');
    await expect(box).toHaveValue('');
    await expectDelivered(page, 'unfinished');
    await expect
      .poll(async () => (await stored((path) => api('dogancan').get(path), made.id)).length)
      .toBe(2);
  });

  test('that ends an IME composition is not a send, and the Enter after it is', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    await box.fill('こんにちは');
    // The engine's own sequence: composition starts, the key that picks a candidate arrives as
    // `Process` / `isComposing`, the composition ends.
    await box.evaluate((field) => {
      field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      field.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      // Safari's order: the keydown that ended it arrives after `compositionend`.
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    await page.waitForTimeout(150);
    await expect(box).toHaveValue('こんにちは');
    expect(await stored((path) => api('dogancan').get(path), made.id)).toEqual([]);

    await box.press('Enter');
    await expectDelivered(page, 'こんにちは');
    await expect
      .poll(async () => await stored((path) => api('dogancan').get(path), made.id))
      .toEqual(['こんにちは']);
  });
});

test.describe('code, written and read (D-188)', () => {
  test('a fence keeps Enter for its lines, Ctrl+Enter sends it, and the block arrives coloured by its language', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    await box.click();
    await page.keyboard.type('```ts');
    await page.keyboard.press('Enter');
    await page.keyboard.type('const answer = 42;');
    await page.keyboard.press('Enter');
    await page.keyboard.type('return answer;');
    await expect(box).toHaveValue('```ts\nconst answer = 42;\nreturn answer;');
    // Nothing was sent by those Enters, and the hint says which key does.
    expect(await stored((path) => api('dogancan').get(path), made.id)).toEqual([]);
    const hint = page.locator(`[id="${(await box.getAttribute('aria-describedby')) ?? ''}"]`);
    // The words follow the keyboard the page sees (`features/shortcuts/platform.ts`): ⌘↵ on a Mac, Ctrl+Enter elsewhere.
    const mac = await page.evaluate(() => {
      const { userAgentData } = navigator as { userAgentData?: { platform?: string } };
      return /mac|iphone|ipad|ipod/i.test(userAgentData?.platform ?? navigator.platform);
    });
    await expect(hint).toContainText(mac ? '⌘↵' : 'Ctrl+Enter');
    await page.keyboard.press('Control+Enter');
    await expect(box).toHaveValue('');
    const block = page.locator('figure', { hasText: 'const answer' });
    await expect(block).toBeVisible();
    // Coloured by the grammar the fence named: a keyword and a number carry different colours.
    // The grammar is a chunk loaded on first use: the block is plain until it arrives.
    await expect(block.locator('code span span').first()).toBeVisible();
    if (onEngine(test.info(), 'webkit')) {
      // Measured on WebKit: the grammar returns `answer = 42;` as one token, so the number is not a span of
      // its own and the two cannot be told apart. That the grammar coloured the block at all is what is
      // asserted there (docs/spikes/cross-browser.md).
      const palette = await block
        .locator('code span span')
        .evaluateAll((spans) => spans.map((span) => getComputedStyle(span).color));
      expect(new Set(palette).size, 'the block is coloured by its grammar').toBeGreaterThan(1);
      return;
    }
    const colours = await block
      .locator('code span span')
      .evaluateAll((spans) =>
        spans
          .filter((span) => ['const', '42'].includes(span.textContent.trim()))
          .map((span) => getComputedStyle(span).color),
      );
    expect(colours).toHaveLength(2);
    expect(new Set(colours).size, 'a keyword and a number are one colour').toBe(2);
  });

  test('the code block chord opens a fence round the selection, and a backtick wraps it', async ({
    page,
    signIn,
    room,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    await box.fill('fix it');
    await box.evaluate((element: HTMLTextAreaElement) => {
      element.setSelectionRange(4, 6);
    });
    await box.press('Control+`');
    // Ctrl with a backtick is the browser's: not ours, nothing wrapped.
    await expect(box).toHaveValue('fix it');
    await box.press('`');
    await expect(box).toHaveValue('fix `it`');
    await box.fill('fix it');
    await box.evaluate((element: HTMLTextAreaElement) => {
      element.setSelectionRange(4, 6);
    });
    await box.press('Control+Alt+Shift+C');
    await expect(box).toHaveValue('fix \n```\nit\n```');
  });
});

test.describe('a paste', () => {
  const paste = async (box: Locator, text: string): Promise<void> => {
    await box.evaluate((field, content) => {
      const data = new DataTransfer();
      data.setData('text/plain', content);
      field.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, text);
  };

  test('of thirty lines becomes a code block, says so, and Undo gives the paste back as it was', async ({
    page,
    signIn,
    room,
  }) => {
    test.skip(
      ['firefox'].includes(test.info().project.name),
      "Firefox gives a synthetic ClipboardEvent no data, so the test's paste reaches the composer empty (docs/spikes/cross-browser.md)",
    );
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    const lines = Array.from({ length: 30 }, (_, index) => `line ${String(index + 1)}`).join('\n');
    await box.fill('before ');
    await paste(box, lines);
    await expect(box).toHaveValue(`before \n\`\`\`\n${lines}\n\`\`\``);
    await expect(page.getByText('Pasted text became a code block')).toBeVisible();

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(box).toHaveValue(`before ${lines}`);
    await expect(box).toBeFocused();
  });

  const syntheticOnly = (): void => {
    test.skip(
      ['firefox'].includes(test.info().project.name),
      "Firefox gives a synthetic ClipboardEvent no data, so the test's paste reaches the composer empty (docs/spikes/cross-browser.md)",
    );
  };

  test('of plain bullets becomes a list, a command becomes inline code, and each can be taken back (D-259)', async ({
    page,
    signIn,
    room,
  }) => {
    syntheticOnly();
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    await paste(box, '• milk\n• bread\n☐ call the bank');
    await expect(box).toHaveValue('- milk\n- bread\n- [ ] call the bank');
    await expect(page.getByText('Pasted bullets became a list')).toBeVisible();
    await page.getByRole('button', { name: 'Paste as text' }).click();
    await expect(box).toHaveValue('• milk\n• bread\n☐ call the bank');

    await box.fill('');
    await paste(box, 'git rebase -i HEAD~3');
    await expect(box).toHaveValue('`git rebase -i HEAD~3`');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(box).toHaveValue('git rebase -i HEAD~3');
  });

  test('of a spreadsheet’s range with its picture is the table; a lone screenshot is a file (D-259)', async ({
    page,
    signIn,
    room,
  }) => {
    syntheticOnly();
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    const withPicture = async (words: string): Promise<void> => {
      await box.evaluate((field, content) => {
        const data = new DataTransfer();
        if (content !== '') data.setData('text/plain', content);
        data.items.add(
          new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }),
        );
        field.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
      }, words);
    };
    await withPicture('Hesap\tTutar\n0102\t1.234,56');
    await expect(box).toHaveValue('| Hesap | Tutar |\n| ---: | ---: |\n| 0102 | 1.234,56 |');
    await expect(page.getByRole('list', { name: 'Files' })).toHaveCount(0);

    await box.fill('');
    await withPicture('');
    await expect(
      page.getByRole('list', { name: 'Files' }).getByText(/^pasted-image-/),
    ).toBeVisible();
  });

  test('of a very long text stays text, and a row offers it as a file until answered (D-259)', async ({
    page,
    signIn,
    room,
  }) => {
    syntheticOnly();
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    const long = Array.from({ length: 600 }, (_, index) => `word ${String(index)}`).join('\n');
    await paste(box, long);
    await expect(page.getByText(/This text is 600 lines long/)).toBeVisible();
    await page.getByRole('button', { name: 'Keep as text' }).click();
    await expect(page.getByText(/lines long/)).toHaveCount(0);
    await expect(box).toHaveValue(/word 599/);

    await box.fill('');
    await paste(box, long);
    await page.getByRole('button', { name: 'Send as file' }).click();
    await expect(box).toHaveValue('');
    await expect(
      page.getByRole('list', { name: 'Files' }).getByText(/^pasted-\d{8}-\d{4}\.txt$/),
    ).toBeVisible();
  });

  test('of a few lines stays text', async ({ page, signIn, room }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    await paste(box, 'one\ntwo\nthree');
    // Nothing intercepted it: the browser's own paste has not happened (the event was synthetic),
    // and no code block or notice appeared.
    await expect(page.getByText('Pasted text became a code block')).toHaveCount(0);
    await expect(box).not.toHaveValue(/```/);
  });
});

test.describe('a draft', () => {
  test('is kept when the person goes to another channel and comes back, and across a reload', async ({
    page,
    signIn,
    room,
  }) => {
    const here = await room({ members: ['dogancan', 'alice'] });
    const there = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(here.path);
    await boxOf(page, here.name).fill('half of a thought');
    // Another channel, by the sidebar (a client-side navigation), and a different draft there.
    await (await navLink(page, there.name)).dispatchEvent('click');
    await expect(boxOf(page, there.name)).toBeVisible();
    await expect(boxOf(page, there.name)).toHaveValue('');
    await boxOf(page, there.name).fill('the other thought');

    await (await navLink(page, here.name)).dispatchEvent('click');
    await expect(boxOf(page, here.name)).toHaveValue('half of a thought');

    await page.reload();
    await expect(boxOf(page, here.name)).toHaveValue('half of a thought');
    await page.goto(there.path);
    await expect(boxOf(page, there.name)).toHaveValue('the other thought');
  });

  test('is gone for good once it is sent: a reload does not bring it back', async ({
    page,
    signIn,
    room,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    await box.fill('sent and gone');
    await box.press('Enter');
    await expect(rowWith(page, 'sent and gone')).toBeVisible();
    await page.reload();
    await expect(rowWith(page, 'sent and gone')).toBeVisible();
    await expect(boxOf(page, made.name)).toHaveValue('');
  });
});

test.describe('what is refused before it leaves', () => {
  test('a message one unit over the limit, with the count of units over, and the draft kept', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    await box.fill('a'.repeat(16_001));
    await box.press('Enter');
    await expect(page.getByText('That is 1 character over the limit.').first()).toBeVisible();
    await expect(box).toHaveValue('a'.repeat(16_001));
    expect(await stored((path) => api('dogancan').get(path), made.id)).toEqual([]);

    // One unit fewer and it goes: the limit is the server's number, not a round one.
    await box.fill('a'.repeat(16_000));
    await box.press('Enter');
    await expect(box).toHaveValue('');
    await expect
      .poll(async () => (await stored((path) => api('dogancan').get(path), made.id))[0]?.length)
      .toBe(16_000);
  });

  test('@here, @channel and @everyone, with the reason, while @alice and a quoted @here go through', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    for (const word of ['@here', '@channel', '@everyone']) {
      await box.fill(`${word} please look`);
      await box.press('Enter');
      await expect(page.getByText(`${word} is not available`, { exact: false })).toBeVisible();
      await expect(box).toHaveValue(`${word} please look`);
    }
    expect(await stored((path) => api('dogancan').get(path), made.id)).toEqual([]);

    await box.fill('`@here` is how Slack does it, @alice');
    await box.press('Enter');
    await expect(rowWith(page, 'is how Slack does it')).toBeVisible();
    await expect(box).toHaveValue('');
  });
});

test.describe('without a connection', () => {
  /**
   * A socket the test can wreck: `up` passes frames both ways, `blackhole` swallows them while the
   * page still believes it is connected (a dead NAT mapping, a sleeping laptop), `down` refuses.
   */
  const wreckable = async (
    page: Page,
  ): Promise<{ set: (mode: 'up' | 'blackhole' | 'down') => void }> => {
    let mode: 'up' | 'blackhole' | 'down' = 'up';
    const open = new Set<WebSocketRoute>();
    await page.routeWebSocket(/\/ws$/, (route) => {
      if (mode === 'down') {
        void route.close();
        return;
      }
      const server = route.connectToServer();
      open.add(route);
      route.onClose(() => {
        open.delete(route);
      });
      route.onMessage((message) => {
        if (mode === 'up') server.send(message);
      });
      server.onMessage((message) => {
        if (mode === 'up') route.send(message);
      });
    });
    return {
      set: (next): void => {
        mode = next;
        if (next === 'down') for (const route of open) void route.close();
      },
    };
  };

  test('a send that gets no answer is painted as sending, fails after three seconds with Retry and Delete, the bar says why, the composer never stops, and Retry delivers it once', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    // The client's backoff after a dead socket is bounded by forty seconds (the wait below), which
    // is longer than the default thirty for the whole test: say so, rather than flake on a busy run.
    test.setTimeout(120_000);
    const made = await room({ members: ['dogancan', 'alice'] });
    const link = await wreckable(page);
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    await expect(box).toBeEnabled();
    await box.fill('before the lights went out');
    await box.press('Enter');
    const first = rowWith(page, 'before the lights went out');
    await expect(first).toBeVisible();
    await expect(first.getByRole('img', { name: 'Sending' })).toHaveCount(0);

    link.set('blackhole');
    await box.fill('written in the dark');
    await box.press('Enter');
    const row = rowWith(page, 'written in the dark');
    await expect(row.getByRole('img', { name: 'Sending' })).toBeVisible();
    // Not before three seconds, and then with both ways out.
    await page.waitForTimeout(2_000);
    await expect(row.getByText('Failed to send')).toHaveCount(0);
    await expect(row.getByText('Failed to send')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Delete' })).toBeVisible();
    // Typing went on the whole time.
    await expect(box).toBeEnabled();
    await expect(box).toBeEditable();
    await box.fill('and one more thought');
    await expect(box).toHaveValue('and one more thought');

    // The socket is found dead: one quiet bar, and the composer still not disabled.
    link.set('down');
    await expect(
      page.getByText('Reconnecting… messages will send when you are back'),
    ).toBeVisible();
    await expect(box).toBeEnabled();
    expect(
      (await stored((path) => api('dogancan').get(path), made.id)).filter(
        (content) => content === 'written in the dark',
      ),
    ).toHaveLength(0);

    link.set('up');
    await expect(page.getByText('Reconnecting… messages will send when you are back')).toHaveCount(
      0,
      { timeout: 40_000 },
    );
    await row.getByRole('button', { name: 'Retry' }).click();
    await expect(row.getByText('Failed to send')).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await stored((path) => api('dogancan').get(path), made.id)).filter(
            (content) => content === 'written in the dark',
          ).length,
      )
      .toBe(1);
    // Exactly once, however long a duplicate has to turn up.
    await page.waitForTimeout(1_500);
    expect(
      (await stored((path) => api('dogancan').get(path), made.id)).filter(
        (content) => content === 'written in the dark',
      ),
    ).toHaveLength(1);
    await expect(rowWith(page, 'written in the dark')).toHaveCount(1);
  });

  test('a failed send can be deleted, and then is nowhere — not on the screen, not on the server', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    const link = await wreckable(page);
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    await expect(box).toBeEnabled();
    link.set('blackhole');
    await box.fill('only to be thrown away');
    await box.press('Enter');
    const row = rowWith(page, 'only to be thrown away');
    await expect(row.getByText('Failed to send')).toBeVisible();
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(row).toHaveCount(0);
    link.set('up');
    await page.waitForTimeout(1_000);
    expect(await stored((path) => api('dogancan').get(path), made.id)).toEqual([]);
  });

  test('with the whole network gone (the browser offline), the composer is still enabled, the send is painted, and what was written is delivered once when the network is back', async ({
    page,
    context,
    signIn,
    room,
    api,
  }) => {
    test.skip(
      onEngine(test.info(), 'webkit', 'firefox'),
      "only Chromium's offline emulation cuts an open WebSocket; elsewhere the send is delivered (docs/spikes/cross-browser.md)",
    );
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    await expect(box).toBeEnabled();
    await context.setOffline(true);
    await expect(box).toBeEnabled();
    await box.fill('sent from a tunnel');
    await box.press('Enter');
    const row = rowWith(page, 'sent from a tunnel');
    await expect(row.getByRole('img', { name: 'Sending' })).toBeVisible();
    await expect(row.getByText('Failed to send')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(box).toBeEnabled();

    await context.setOffline(false);
    // The frame may already be on its way (the socket never knew), or the person presses Retry:
    // either way the row ends up delivered, and the server has it once.
    const retry = row.getByRole('button', { name: 'Retry' });
    await expect
      .poll(async () => {
        await retry.click({ timeout: 1_000 }).catch(() => undefined);
        return await row.getByText('Failed to send').count();
      })
      .toBe(0);
    await expect
      .poll(
        async () =>
          (await stored((path) => api('dogancan').get(path), made.id)).filter(
            (content) => content === 'sent from a tunnel',
          ).length,
      )
      .toBe(1);
    await page.waitForTimeout(1_000);
    expect(await stored((path) => api('dogancan').get(path), made.id)).toEqual([
      'sent from a tunnel',
    ]);
  });
});

test.describe('@ and a name', () => {
  for (const state of ['loading', 'failure'] as const) {
    test(`guest public-channel mentions recover from ${state} and stay scoped at 320, 820 and 1440 pixels`, async ({
      page,
      signIn,
      room,
      world,
      api,
      expectNoAxe,
    }, testInfo) => {
      const made = await room({ members: ['dogancan', 'alice'] });
      // Controlled role data exercises the browser's guest branch. Real guest authorization is proved
      // separately through SQL and HTTP; this test does not enable production guest admission.
      await page.route('**/api/me', async (route) => {
        const response = await route.fetch();
        const body: unknown = await response.json();
        if (!Value.Check(MeResponse, body))
          throw new Error('The fixture session did not match its contract');
        await route.fulfill({
          response,
          json: {
            ...body,
            memberships: body.memberships.map((membership) =>
              membership.workspace.id === world.workspace.id
                ? {
                    ...membership,
                    role: 'member',
                    access: { kind: 'guest', historySince: membership.joinedAt, expiresAt: null },
                  }
                : membership,
            ),
          },
        });
      });
      const release = Promise.withResolvers<undefined>();
      let failing = state === 'failure';
      await page.route(`**/api/channels/${made.id}/members`, async (route) => {
        if (failing) {
          await route.fulfill({
            status: 503,
            json: { error: { code: 'DATABASE_UNAVAILABLE', message: 'Try again.' } },
          });
          return;
        }
        await release.promise;
        await route.continue();
      });
      await signIn();
      await page.setViewportSize({ width: 320, height: 900 });
      await page.goto(made.path);
      const box = boxOf(page, made.name);
      await box.fill('@ali');
      if (state === 'failure') {
        const failed = page.getByRole('status', { name: /could not be read/i });
        await expect(failed).toBeVisible();
        await expect(box).toHaveValue('@ali');
        await expectNoAxe();
        failing = false;
        await failed.getByRole('button', { name: 'Retry' }).click();
        await expect(box).toBeFocused();
      }
      await expect(page.getByRole('status', { name: /reading/i })).toBeVisible();
      await expect(page.getByRole('listbox', { name: 'People to mention' })).toHaveCount(0);
      release.resolve(undefined);
      const list = page.getByRole('listbox', { name: 'People to mention' });
      for (const width of [320, 820, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await box.fill('@ali');
        await expect(list.getByRole('option', { name: /Alice Chen/ })).toBeVisible();
        await expectNoAxe();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`guest-mentions-${String(width)}.png`) });
        await box.press('Escape');
        await expect(list).toHaveCount(0);
        await expect(box).toHaveValue('@ali');
        await expect(box).toBeFocused();
        await box.fill('Hello @bob');
        await expect(page.getByRole('option', { name: /Bob/ })).toHaveCount(0);
        await box.fill('Can you check, @ali');
        await expect(list.getByRole('option', { name: /Alice Chen/ })).toBeVisible();
        await box.press('Enter');
        await expect(box).toHaveValue('Can you check, @alice ');
        await expect(box).toBeFocused();
        expect(await stored((path) => api('dogancan').get(path), made.id)).toEqual([]);
        await box.fill('');
      }
    });
  }

  test('typing @ali offers Alice; choosing her writes her handle, and what is sent is a mention', async ({
    page,
    signIn,
    room,
    api,
    expectNoAxe,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    await box.pressSequentially('can you look, @ali');
    const list = page.getByRole('listbox', { name: 'People to mention' });
    await expect(list).toBeVisible();
    const alice = list.getByRole('option', { name: /Alice Chen/ });
    await expect(alice).toHaveAttribute('aria-selected', 'true');
    await expect(box).toHaveAttribute(
      'aria-activedescendant',
      (await alice.getAttribute('id')) ?? 'missing',
    );
    // The open list is audited where it is drawn: names, roles and contrast, in this project's theme.
    await expectNoAxe();
    await alice.click();
    await expect(list).toHaveCount(0);
    await expect(box).toHaveValue('can you look, @alice ');
    await expect(box).toBeFocused();
    await box.pressSequentially('please?');
    await box.press('Enter');
    await expectDelivered(page, 'please?');
    // Drawn as a mention: the server resolved the handle to Alice.
    await expect(rowWith(page, 'please?').locator('[data-mention]')).toHaveText('@alice');
    expect(await stored((path) => api('dogancan').get(path), made.id)).toEqual([
      'can you look, @alice please?',
    ]);
  });

  test('Enter while the list is open chooses and does not send; Esc closes it and keeps the text', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    await box.pressSequentially('@ali');
    const list = page.getByRole('listbox', { name: 'People to mention' });
    // The list is there before Enter is pressed: Enter with no list is a send, as it should be.
    await expect(list.getByRole('option', { name: /Alice Chen/ })).toBeVisible();
    await box.press('Enter');
    await expect(box).toHaveValue('@alice ');
    await box.pressSequentially('and @bo');
    await expect(list.getByRole('option', { name: /Bob Okafor/ })).toBeVisible();
    await box.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(box).toHaveValue('@alice and @bo');
    await expect(box).toBeFocused();
    expect(await stored((path) => api('dogancan').get(path), made.id)).toEqual([]);
  });
});

test.describe('the formatting row, the emoji picker and the preview (D-181)', () => {
  test('a button only inserts markdown: the server holds the text, a list carries on with Shift+Enter, and the message is drawn bold', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    await box.click();
    await page.getByRole('button', { name: 'Bold' }).click();
    await page.keyboard.type('ship it');
    await expect(box).toHaveValue('**ship it**');
    // The caret to the end by script: a key races the caret the button put between the markers.
    await box.evaluate((el: HTMLTextAreaElement) => {
      el.setSelectionRange(el.value.length, el.value.length);
    });
    await box.press('Shift+Enter');
    await page.getByRole('button', { name: 'Bulleted list' }).click();
    await page.keyboard.type('one');
    await box.press('Shift+Enter');
    await expect(box).toHaveValue('**ship it**\n- one\n- ');
    await page.keyboard.type('two');
    await box.press('Enter');
    await expectDelivered(page, 'two');
    expect(await stored((path) => api('dogancan').get(path), made.id)).toEqual([
      '**ship it**\n- one\n- two',
    ]);
    await expect(rowWith(page, 'two').locator('strong')).toHaveText('ship it');
  });

  test('the emoji picker writes the emoji at the caret and gives the focus back; Esc closes it with nothing written', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    await box.fill('done');
    await page.getByRole('button', { name: 'Add an emoji' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitemcheckbox', { name: '🚀' })).toHaveCount(0);
    await expect(box).toBeFocused();
    await expect(box).toHaveValue('done');
    await page.getByRole('button', { name: 'Add an emoji' }).click();
    await page.getByRole('menuitemcheckbox', { name: '🚀' }).click();
    await expect(box).toHaveValue('done🚀');
    await expect(box).toBeFocused();
    await box.press('Enter');
    await expectDelivered(page, 'done🚀');
    expect(await stored((path) => api('dogancan').get(path), made.id)).toEqual(['done🚀']);
  });

  test('the preview draws the draft as it will be sent, and a second press goes back to the text untouched', async ({
    page,
    signIn,
    room,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    await box.fill('a **bold** and `code` word');
    await page.getByRole('button', { name: 'Preview' }).click();
    const preview = page.locator('[data-composer-preview]');
    await expect(preview.locator('strong')).toHaveText('bold');
    await expect(preview.locator('code')).toHaveText('code');
    await expect(page.getByRole('button', { name: 'Preview' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(preview).toHaveCount(0);
    await expect(box).toBeFocused();
    await expect(box).toHaveValue('a **bold** and `code` word');
  });
});
