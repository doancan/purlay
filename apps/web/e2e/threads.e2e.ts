/**
 * The wedge, end to end (`UX.md` §4, D-99 §5): a thread opens in place under its question, can be
 * answered and closed from the keyboard, and the questions nobody has answered yet are one screen
 * away. Every test makes its own room, so threads opened and closed here are nobody else's.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test, type Persona, type Room } from './fixtures';
import { history, writeInParallel, type ApiClient } from './support';

const rowWith = (page: Page, text: string): Locator =>
  page.locator('[data-message-row]', { hasText: text });

interface Question extends Room {
  readonly rootId: string;
  readonly question: string;
}

/** A room with one question and two answers, the viewer in it. */
const aQuestion = async (
  room: (options?: { members?: readonly Persona[] }) => Promise<Room>,
  api: (persona: Persona) => ApiClient,
): Promise<Question> => {
  const made = await room({ members: ['dogancan', 'alice', 'bob'] });
  const question = `why is the backoff four seconds in ${made.name}?`;
  const root = await api('carol').say(made.id, question);
  await api('bob').say(made.id, 'the upstream rate limit', { parentId: root.id });
  await api('carol').say(made.id, 'documented in the postmortem', { parentId: root.id });
  return { ...made, rootId: root.id, question };
};

const threadOf = (page: Page, rootId: string): Locator =>
  page.locator(`[data-thread-root="${rootId}"]`);

test.describe('opening and closing a thread', () => {
  test('with the mouse: in place under its question, and the question does not move', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await aQuestion(room, api);
    await signIn();
    await page.goto(made.path);
    const row = rowWith(page, made.question);
    const before = (await row.boundingBox())?.y ?? -1;
    await page.getByRole('button', { name: /Open · 2 replies/ }).click();
    const thread = threadOf(page, made.rootId);
    await expect(thread).toBeVisible();
    await expect(thread.getByText('the upstream rate limit')).toBeVisible();
    // Opened under the question, not beside it (there is no drawer), and the question stayed.
    expect(await page.getByRole('dialog').count()).toBe(0);
    expect(Math.abs(((await row.boundingBox())?.y ?? -1) - before)).toBeLessThan(1.5);

    await thread.getByRole('button', { name: /^Collapse/ }).click();
    await expect(thread).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Open · 2 replies/ })).toBeVisible();
  });

  test('with the keyboard: T opens the focused question’s thread, Esc closes it, and R goes straight to the reply box', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await aQuestion(room, api);
    await signIn();
    await page.goto(made.path);
    const row = rowWith(page, made.question);
    await row.focus();
    await page.keyboard.press('t');
    const thread = threadOf(page, made.rootId);
    await expect(thread).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(thread).toHaveCount(0);

    await row.focus();
    await page.keyboard.press('r');
    await expect(thread).toBeVisible();
    await expect(thread.getByRole('textbox')).toBeFocused();
  });
});

test.describe('answering', () => {
  test('from the inline reply box: the answer appears under the question, the count follows, and the server has exactly one', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await aQuestion(room, api);
    await signIn();
    await page.goto(made.path);
    await page.getByRole('button', { name: /Open · 2 replies/ }).click();
    const thread = threadOf(page, made.rootId);
    const reply = thread.getByRole('textbox');
    await reply.fill('so it will stay at four');
    await reply.press('Enter');
    await expect(thread.getByText('so it will stay at four')).toBeVisible();
    await expect(thread.getByRole('button', { name: /^3 replies/ })).toBeVisible();

    const replies = await api('dogancan').get<{ data: { content: string }[] }>(
      `/api/messages/${made.rootId}/thread`,
    );
    expect(replies.data.filter((r) => r.content === 'so it will stay at four')).toHaveLength(1);
    // One row for it, inside the thread: a reply has no row of its own in the channel's feed.
    await expect(
      thread.locator('[data-message-row]', { hasText: 'so it will stay at four' }),
    ).toHaveCount(1);
  });
});

test.describe('resolving', () => {
  test('with Cmd/Ctrl+Shift+R: the thread closes and reads as resolved, the page does not reload, and the same keys reopen it', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await aQuestion(room, api);
    await signIn();
    await page.goto(made.path);
    await expect(page.getByRole('button', { name: /Open · 2 replies/ })).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __stayed: boolean }).__stayed = true;
    });
    const row = rowWith(page, made.question);
    await row.focus();
    await page.keyboard.press('t');
    await expect(threadOf(page, made.rootId)).toBeVisible();

    await page.keyboard.press('ControlOrMeta+Shift+R');
    await expect(
      page.getByRole('button', { name: /Resolved by dogancan · 2 replies/ }),
    ).toBeVisible();
    await expect(threadOf(page, made.rootId)).toHaveCount(0);
    // The browser's own shortcut would have reloaded the page and thrown this away.
    expect(await page.evaluate(() => (window as unknown as { __stayed?: boolean }).__stayed)).toBe(
      true,
    );
    // Resolved is dimmed in the feed: the channel goes quiet as questions close.
    await expect(rowWith(page, made.question).locator('.text-ink-muted').first()).toBeVisible();

    // Reopening is done from inside the thread, so it stays open: resolved becomes open, in place.
    await row.focus();
    await page.keyboard.press('t');
    await expect(threadOf(page, made.rootId)).toBeVisible();
    await page.keyboard.press('ControlOrMeta+Shift+R');
    await expect(
      threadOf(page, made.rootId).getByRole('button', { name: /^Resolve/ }),
    ).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __stayed?: boolean }).__stayed)).toBe(
      true,
    );
    // And the server agrees at each step.
    const root = await api('dogancan').get<{
      data: { thread: { resolvedAt: string | null } | null }[];
    }>(`/api/channels/${made.id}/messages?limit=5`);
    expect(root.data.at(-1)?.thread?.resolvedAt ?? null).toBeNull();
  });

  test('has the one animation in the product under normal motion, and none under reduced motion', async ({
    browser,
    baseURL,
    room,
    api,
    world,
  }, info) => {
    const made = await aQuestion(room, api);
    const measure = async (reducedMotion: 'reduce' | 'no-preference'): Promise<number[]> => {
      const { colorScheme, viewport } = info.project.use;
      const context = await browser.newContext({
        baseURL: baseURL ?? '',
        reducedMotion,
        ...(colorScheme === undefined ? {} : { colorScheme }),
        ...(viewport === undefined ? {} : { viewport }),
      });
      await context.addCookies([
        {
          name: '__Host-purlay_session',
          value: world.personas.dogancan.token,
          domain: new URL(baseURL ?? 'http://localhost').hostname,
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ]);
      const tab = await context.newPage();
      await tab.goto(made.path);
      await tab.getByRole('button', { name: /Open · 2 replies/ }).click();
      const thread = threadOf(tab, made.rootId);
      await expect(thread).toBeVisible();
      // Press Resolve in the page and sample the thread's height on every frame until it is gone.
      const heights = await tab.evaluate(async (rootId) => {
        const section = document.querySelector<HTMLElement>(`[data-thread-root="${rootId}"]`);
        const button = [...(section?.querySelectorAll('button') ?? [])].find((b) =>
          b.textContent.startsWith('Resolve'),
        );
        if (section === null || button === undefined) return [-1];
        const samples: number[] = [];
        button.click();
        await new Promise<void>((resolve) => {
          const step = (): void => {
            const live = document.querySelector<HTMLElement>(`[data-thread-root="${rootId}"]`);
            if (live === null || samples.length > 60) {
              resolve();
              return;
            }
            samples.push(live.getBoundingClientRect().height);
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
        return samples;
      }, made.rootId);
      await context.close();
      return heights;
    };

    const animated = await measure('no-preference');
    // Several frames in which the thread is shrinking, and getting smaller as it goes.
    expect(animated.length).toBeGreaterThan(2);
    expect(animated[0] ?? 0).toBeGreaterThan(animated.at(-1) ?? 0);

    // Resolved once already: reopen through the API so the second run starts from an open thread.
    await api('dogancan').del(`/api/messages/${made.rootId}/resolve`);
    const instant = await measure('reduce');
    expect(instant.length).toBeLessThanOrEqual(2);
  });
});

test.describe('the open questions', () => {
  test('are grouped by channel with a count, open the thread in its channel, and drop a question the moment it is resolved', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await aQuestion(room, api);
    await signIn();
    await page.goto('/w/acme-eng/questions');
    const group = page.getByRole('region', { name: new RegExp(made.name) });
    await expect(group).toBeVisible();
    await expect(group).toContainText('1');
    const entry = group.getByRole('button', { name: new RegExp(made.question.slice(0, 30)) });
    await expect(entry).toContainText('2 replies');

    await entry.click();
    await expect(page).toHaveURL(new RegExp(`/c/${made.id}\\?thread=${made.rootId}`));
    await expect(threadOf(page, made.rootId)).toBeVisible();

    // Back in the list, a thread resolved by somebody else is gone without a reload.
    await page.goto('/w/acme-eng/questions');
    await expect(group).toBeVisible();
    await api('carol').resolve(made.rootId);
    await expect(group).toHaveCount(0, { timeout: 5_000 });
  });

  test('a link with ?thread= lands on a thread older than the first page, opened and in sight', async ({
    page,
    signIn,
    room,
    api,
    tenant,
  }) => {
    test.setTimeout(120_000);
    const made = await room({ members: ['dogancan', 'alice', 'bob', 'carol'] });
    const root = await api('carol').say(made.id, `an old question in ${made.name}`);
    await api('bob').say(made.id, 'an old answer', { parentId: root.id });
    await writeInParallel(tenant, made.id, history(90));
    await api('dogancan').markRead(
      made.id,
      (
        await api('dogancan').get<{ data: { id: string }[] }>(
          `/api/channels/${made.id}/messages?limit=1`,
        )
      ).data[0]?.id ?? '',
    );
    await signIn();
    await page.goto(`${made.path}?thread=${root.id}`);
    const thread = threadOf(page, root.id);
    await expect(thread).toBeVisible({ timeout: 10_000 });
    await expect(thread.getByText('an old answer')).toBeVisible();
    // In sight: inside the visible part of the feed, not above or below it.
    const box = await thread.boundingBox();
    const frame = await page.getByRole('feed').locator('..').boundingBox();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual((frame?.y ?? 0) - 1);
    expect(box?.y ?? 1e9).toBeLessThanOrEqual((frame?.y ?? 0) + (frame?.height ?? 0));
  });

  test('says so when every thread is resolved', async ({ page, signIn }) => {
    // A workspace-wide view cannot be emptied by one test; the empty state is asserted on the
    // component with the API faked (`questions-screen.test.tsx`). Here: the screen is reachable
    // and its header says what it is.
    await signIn();
    await page.goto('/w/acme-eng/questions');
    await expect(page.getByRole('heading', { level: 1, name: 'Open questions' })).toBeVisible();
  });
});
