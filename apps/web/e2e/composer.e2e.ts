/**
 * The box people write in (`UX.md` §5, D-99 §3): what Enter does in each situation, what a
 * paste becomes, what survives a switch or a reload, what is refused before it leaves, and what
 * happens to a send when the network is not there. The composer is never disabled — the one
 * promise that makes a bad connection bearable — and the offline test is where that is held.
 *
 * Every test has a room of its own (`support.ts`); what "sent" means is read from the server.
 */
import type { Locator, Page, WebSocketRoute } from '@playwright/test';
import { expect, test } from './fixtures';

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
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = boxOf(page, made.name);
    const lines = Array.from({ length: 30 }, (_, index) => `line ${String(index + 1)}`).join('\n');
    await box.fill('before ');
    await paste(box, lines);
    await expect(box).toHaveValue(`before \`\`\`\n${lines}\n\`\`\``);
    await expect(page.getByText('Pasted text became a code block')).toBeVisible();

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(box).toHaveValue('before ');
    await expect(box).toBeFocused();
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
    await page
      .getByRole('complementary')
      .getByRole('link', { name: new RegExp(`^(unread )?${there.name}`) })
      .dispatchEvent('click');
    await expect(boxOf(page, there.name)).toBeVisible();
    await expect(boxOf(page, there.name)).toHaveValue('');
    await boxOf(page, there.name).fill('the other thought');

    await page
      .getByRole('complementary')
      .getByRole('link', { name: new RegExp(`^(unread )?${here.name}`) })
      .dispatchEvent('click');
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
        if (await retry.isVisible()) await retry.click({ timeout: 1_000 }).catch(() => undefined);
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
