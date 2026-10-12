/**
 * Two people in one channel, each in a real browser: what one does, the other sees — without a
 * reload, within a second, and without anything under their eyes moving.
 *
 * This is the product's reason to exist as a *live* tool, and the one thing a component test
 * cannot show: the socket, the server's transaction, the fan-out and the cache all have to agree.
 * Every test makes a room of its own (`support.ts`).
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { navLink } from './support';

const composer = (page: Page, name: string): Locator =>
  page.getByRole('textbox', { name: `Message ${name}` });

const rowWith = (page: Page, text: string): Locator =>
  page.locator('[data-message-row]', { hasText: text });

test.describe('a message', () => {
  test('sent by one person appears for the other within a second, in the same place for both', async ({
    page,
    signIn,
    room,
    asPerson,
  }) => {
    const made = await room({ messages: [{ by: 'alice', text: 'the first message of the room' }] });
    await signIn();
    await page.goto(made.path);
    const alice = await asPerson('alice');
    await alice.goto(made.path);
    await expect(rowWith(alice, 'the first message of the room')).toBeVisible();

    // When the row reaches the other person's DOM, by that page's own clock — not when
    // Playwright's polling next looked — against when the server stamped the message.
    await page.evaluate(() => {
      const seen: { text: string; at: number }[] = [];
      (window as unknown as { __seen: typeof seen }).__seen = seen;
      new MutationObserver(() => {
        for (const row of document.querySelectorAll('[data-message-row]')) {
          const text = row.textContent;
          if (
            !seen.some((entry) => text.includes(entry.text)) &&
            text.includes('hello from alice, live')
          ) {
            seen.push({
              text: 'hello from alice, live',
              at: performance.timeOrigin + performance.now(),
            });
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await composer(alice, made.name).fill('hello from alice, live');
    await composer(alice, made.name).press('Enter');
    // Her own row first: if the server refused it, that is the failure, not a missing row on his page.
    await expect(rowWith(alice, 'hello from alice, live')).toBeVisible();
    await expect(
      rowWith(alice, 'hello from alice, live').getByRole('img', { name: 'Sending' }),
    ).toHaveCount(0);
    const failure = await rowWith(alice, 'hello from alice, live')
      .getByText('Failed to send', { exact: true })
      .count();
    if (failure > 0) {
      throw new Error(
        `alice's send failed: ${await rowWith(alice, 'hello from alice, live').innerText()}`,
      );
    }
    await expect(rowWith(page, 'hello from alice, live')).toBeVisible();
    const stamped = await alice
      .locator('[data-message-row]', { hasText: 'hello from alice, live' })
      .locator('time')
      .getAttribute('datetime');
    const arrivedAt = await page.evaluate(
      () => (window as unknown as { __seen: { at: number }[] }).__seen[0]?.at ?? -1,
    );
    expect(arrivedAt - Date.parse(stamped ?? '')).toBeLessThan(1_000);
    // Same order on both screens: the new message is the last row on each.
    const lastOn = async (p: Page): Promise<string | null> =>
      await p.locator('[data-message-row]').last().getAttribute('data-message-id');
    expect(await lastOn(page)).toBe(await lastOn(alice));
  });

  test('is painted as sending the instant it is sent and settles in the same place when the server answers', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({ messages: [{ by: 'alice', text: 'something above it' }] });
    await signIn();
    // The server's answers are held for half a second, so the sending state can be looked at.
    await page.routeWebSocket(/\/ws$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        server.send(message);
      });
      server.onMessage((message) => {
        setTimeout(() => {
          ws.send(message);
        }, 500);
      });
    });
    await page.goto(made.path);
    await expect(rowWith(page, 'something above it')).toBeVisible();

    const box = composer(page, made.name);
    await box.fill('painted before the server answers');
    await box.press('Enter');
    const row = rowWith(page, 'painted before the server answers');
    await expect(row).toBeVisible();
    await expect(row.getByRole('img', { name: 'Sending' })).toBeVisible();
    const id = await row.getAttribute('data-message-id');
    const before = (await row.boundingBox())?.y ?? -1;
    const order = await page
      .locator('[data-message-row]')
      .evaluateAll(
        (rows, wanted) => rows.map((r) => r.getAttribute('data-message-id')).indexOf(wanted),
        id,
      );

    await expect(row.getByRole('img', { name: 'Sending' })).toHaveCount(0, { timeout: 3_000 });
    // The same element, the same id, the same place in the list and on the screen: nothing moved.
    expect(await row.getAttribute('data-message-id')).toBe(id);
    expect(Math.abs(((await row.boundingBox())?.y ?? -1) - before)).toBeLessThan(0.5);
    expect(
      await page
        .locator('[data-message-row]')
        .evaluateAll(
          (rows, wanted) => rows.map((r) => r.getAttribute('data-message-id')).indexOf(wanted),
          id,
        ),
    ).toBe(order);
    // And exactly one message of that text exists on the server.
    const list = await api('dogancan').get<{ data: { content: string }[] }>(
      `/api/channels/${made.id}/messages?limit=20`,
    );
    expect(list.data.filter((m) => m.content === 'painted before the server answers')).toHaveLength(
      1,
    );
  });

  test('that names someone raises their badge live, and reading the channel clears it', async ({
    page,
    signIn,
    room,
    asPerson,
    api,
  }) => {
    const made = await room({ messages: [{ by: 'dogancan', text: 'a room for two' }] });
    await signIn();
    await page.goto(made.path);
    await expect(rowWith(page, 'a room for two')).toBeVisible();
    const alice = await asPerson('alice');
    // Alice is somewhere else: another room's address, so this channel can raise a badge for her.
    const elsewhere = await room({ members: ['alice', 'dogancan'] });
    await alice.goto(elsewhere.path);
    await expect(await navLink(alice, made.name)).toBeVisible();
    expect(await api('alice').channelState(made.id)).toMatchObject({ unreadCount: 1 });

    await composer(page, made.name).fill('@alice could you look at this');
    await composer(page, made.name).press('Enter');
    const link = await navLink(alice, made.name);
    // The server first (it is the truth the page is told), then the page.
    await expect
      .poll(async () => (await api('alice').channelState(made.id))?.unreadMentionCount)
      .toBe(1);
    await expect(link.getByLabel('1 unread mention')).toBeVisible();
    await expect(link).toContainText('unread');
    // The server's own numbers, not the page's guess.
    // Two unread, because she was in the room when the first line was written; one needs her.
    expect(await api('alice').channelState(made.id)).toMatchObject({
      unreadCount: 2,
      unreadMentionCount: 1,
    });

    // Other tests are writing to other rooms of this workspace right now, and the sidebar is in
    // recency order: a real pointer aimed at the row can find another row under it by the time it
    // lands. The click is delivered to the element itself.
    await link.dispatchEvent('click');
    await expect(rowWith(alice, 'could you look at this')).toBeVisible();
    await expect(link.getByLabel('1 unread mention')).toHaveCount(0);
    await expect.poll(async () => (await api('alice').channelState(made.id))?.unreadCount).toBe(0);
  });

  test('is not announced to a channel the person is in, as noise: only what needs them raises a badge', async ({
    page,
    signIn,
    room,
    asPerson,
  }) => {
    const made = await room({ messages: [{ by: 'dogancan', text: 'ordinary talk' }] });
    await signIn();
    await page.goto(made.path);
    const alice = await asPerson('alice');
    const elsewhere = await room({ members: ['alice', 'dogancan'] });
    await alice.goto(elsewhere.path);
    await composer(page, made.name).fill('no mention in this one');
    await composer(page, made.name).press('Enter');
    // Bold, because there is something unread — and no badge, because nothing needs her.
    await expect(await navLink(alice, made.name)).toContainText('unread');
    await expect(
      (await navLink(alice, made.name)).locator(
        '[aria-label$="unread mention"], [aria-label$="unread mentions"]',
      ),
    ).toHaveCount(0);
  });
});

test.describe('a thread', () => {
  test('updates its summary live when collapsed and gains the reply live when open', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'alice', 'bob'] });
    const alice = api('alice');
    const bob = api('bob');
    const root = await alice.say(made.id, 'why is the retry backoff four seconds?');
    await bob.say(made.id, 'it is the upstream rate limit', { parentId: root.id });
    await signIn();
    await page.goto(made.path);

    const status = page.getByRole('button', { name: /Open · 1 reply/ });
    await expect(status).toBeVisible();
    await bob.say(made.id, 'documented in the postmortem', { parentId: root.id });
    await expect(page.getByRole('button', { name: /Open · 2 replies/ })).toBeVisible();

    await page.getByRole('button', { name: /Open · 2 replies/ }).click();
    const thread = page.locator(`[data-thread-root="${root.id}"]`);
    await expect(thread).toBeVisible();
    await expect(thread.getByText('documented in the postmortem')).toBeVisible();
    await alice.say(made.id, 'linking it here', { parentId: root.id });
    await expect(thread.getByText('linking it here')).toBeVisible();
    await expect(thread.getByRole('button', { name: /^3 replies/ })).toBeVisible();
  });

  test('resolved by another person shows as resolved at once, and leaves the open questions', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'alice', 'bob'] });
    const alice = api('alice');
    const question = `is ${made.name} migrated?`;
    const root = await alice.say(made.id, question);
    await api('bob').say(made.id, 'yes, 0013 is applied', { parentId: root.id });
    await signIn();
    await page.goto(made.path);
    await expect(page.getByRole('button', { name: /Open · 1 reply/ })).toBeVisible();

    // The questions view, in a second tab of the same person: the room's question is listed.
    const questions = await page.context().newPage();
    await questions.goto(`/w/acme-eng/questions`);
    await expect(questions.getByText(question)).toBeVisible();

    await alice.resolve(root.id);
    await expect(page.getByRole('button', { name: /Resolved by alice · 1 reply/ })).toBeVisible();
    await expect(questions.getByText(question)).toHaveCount(0, {
      timeout: 5_000,
    });
    // The root is dimmed: the feed goes quiet as questions close.
    await expect(rowWith(page, question).locator('div.text-ink-muted').first()).toBeVisible();
  });
});

test.describe('a reaction', () => {
  test('made by one person appears for the other, counted, and is taken back the same way', async ({
    page,
    signIn,
    room,
    asPerson,
  }) => {
    const made = await room({ messages: [{ by: 'dogancan', text: 'ship it?' }] });
    await signIn();
    await page.goto(made.path);
    const alice = await asPerson('alice');
    await alice.goto(made.path);
    const aliceRow = rowWith(alice, 'ship it?');
    await aliceRow.hover();
    await aliceRow.getByRole('button', { name: 'Add reaction' }).click();
    await alice.getByRole('menuitem', { name: /Ship it/ }).click();
    await expect(alice.getByText('The reaction was not saved. Try again.')).toHaveCount(0);

    const chip = rowWith(page, 'ship it?').getByRole('button', { name: '🚀, 1 reaction' });
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    // Her own chip says it is hers; pressing it takes the reaction back for everyone.
    const hers = aliceRow.getByRole('button', { name: '🚀, 1 reaction' });
    await expect(hers).toHaveAttribute('aria-pressed', 'true');
    await hers.click();
    // Her own page first: if the take-back was refused, that is the failure, not a stale chip on his.
    await expect(hers).toHaveCount(0);
    await expect(alice.getByText('The reaction was not saved. Try again.')).toHaveCount(0);
    await expect(chip).toHaveCount(0);
  });
});

test.describe('a message somebody else revises', () => {
  test('edited, it shows the new words and says it was edited, without a reload', async ({
    page,
    signIn,
    room,
    api,
    expectNoAxe,
  }) => {
    const made = await room({ messages: [{ by: 'alice', text: 'teh deploy is at noon' }] });
    await signIn();
    await page.goto(made.path);
    await expect(rowWith(page, 'teh deploy is at noon')).toBeVisible();
    const said = rowWith(page, 'teh deploy is at noon');
    const id = await said.getAttribute('data-message-id');
    if (id === null) throw new Error('the row names no message');

    await api('alice').edit(id, 'the deploy is at noon');

    const row = page.locator(`[data-message-id="${id}"]`);
    await expect(row).toContainText('the deploy is at noon');
    await expect(row).toContainText('edited');
    await expect(row).not.toContainText('teh deploy');
    await expectNoAxe(row);
  });

  test('deleted with an answer, it stays as its tombstone and keeps the thread; without one, it goes', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({
      messages: [
        { by: 'alice', text: 'a question about the cache' },
        { by: 'alice', text: 'never mind this one' },
      ],
    });
    await signIn();
    await page.goto(made.path);
    const question = rowWith(page, 'a question about the cache');
    const aside = rowWith(page, 'never mind this one');
    await expect(aside).toBeVisible();
    const questionId = await question.getAttribute('data-message-id');
    const asideId = await aside.getAttribute('data-message-id');
    if (questionId === null || asideId === null) throw new Error('the rows name no message');
    await api('bob').say(made.id, 'it is documented', { parentId: questionId });
    await expect(page.locator(`[data-message-id="${questionId}"]`)).toContainText('1 reply');

    await api('alice').remove(questionId);
    await api('alice').remove(asideId);

    const tombstone = page.locator(`[data-message-id="${questionId}"]`);
    await expect(tombstone).toContainText('This message was deleted.');
    await expect(tombstone).toContainText('1 reply');
    await expect(page.locator(`[data-message-id="${asideId}"]`)).toHaveCount(0);
  });
});

test.describe('typing', () => {
  test('one person typing is named under the other’s composer, and the line goes when the message arrives', async ({
    page,
    signIn,
    room,
    asPerson,
  }) => {
    const made = await room({ messages: [{ by: 'alice', text: 'a room to type in' }] });
    await signIn();
    await page.goto(made.path);
    const alice = await asPerson('alice');
    await alice.goto(made.path);
    await expect(rowWith(page, 'a room to type in')).toBeVisible();
    await expect(rowWith(alice, 'a room to type in')).toBeVisible();
    const line = page.getByText(/is typing…$/);

    await composer(alice, made.name).pressSequentially('almost');
    await expect(line).toBeVisible();
    // Never told about themselves.
    await expect(alice.getByText(/is typing…$/)).toHaveCount(0);

    await composer(alice, made.name).press('Enter');
    await expect(rowWith(page, 'almost')).toBeVisible();
    // Gone with the message, which arrived in the same frame handling as the row — well inside the
    // announcement's six seconds, which would clear it anyway and so prove nothing.
    await expect(line).toHaveCount(0, { timeout: 2_000 });
  });
});
