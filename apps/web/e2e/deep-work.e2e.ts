/**
 * Deep Work for a chosen while (D-124), against the real API: the instant chosen is what the server
 * keeps, the header says so, and it ends when asked.
 *
 * As an outsider in a workspace of their own (`fixtures.ts`): Deep Work is set on a membership, and
 * done as one of the seeded four it would quiet the badges other tests photograph.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { shellReady } from './support';

const palette = async (page: Page, choose: string): Promise<void> => {
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox').fill(choose);
  // The choice itself — "Deep Work: For 2 hours", "End Deep Work" — not the palette's last row, which
  // offers to search messages for whatever was typed (D-157).
  await dialog.getByRole('option', { name: new RegExp(`(^|: )${choose}$`) }).click();
};

/**
 * The server's own clock, from the `Date` header of its answer (whole seconds, so the true instant is
 * up to a second later). Deep Work is judged against this clock alone: the test process's clock is
 * a monotonic one added to its start time, which drifts from the wall clock over a long run.
 */
const serverClock = async (page: Page): Promise<number> => {
  const response = await page.request.get('/api/me');
  const stamp = response.headers()['date'];
  expect(stamp, 'the API answers with a Date header').toBeTruthy();
  return Date.parse(stamp ?? '');
};

/** When the server says this person's Deep Work in the workspace ends: null until it has written it. */
const heldUntil = async (page: Page, workspaceId: string): Promise<string | null> => {
  const me = (await (await page.request.get('/api/me')).json()) as {
    memberships: { workspace: { id: string }; deepWorkUntil: string | null }[];
  };
  return me.memberships.find((m) => m.workspace.id === workspaceId)?.deepWorkUntil ?? null;
};

test.describe('Deep Work', () => {
  test('for two hours is kept by the server, said in the header, and ends when asked', async ({
    asOutsider,
    workspaceOf,
  }) => {
    const workspace = await workspaceOf('frank');
    const page = await asOutsider('frank');
    await page.goto(`/w/${workspace.slug}`);
    await shellReady(page);

    const before = await serverClock(page);
    await palette(page, 'For 2 hours');
    const bar = page.getByRole('status').filter({ hasText: /Deep Work until/ });
    await expect(bar).toBeVisible();

    // What the server holds is two hours from when it was asked, not the shortcut's one. The header
    // answers the moment the choice is made, before the server has written it: the server's own record
    // is what is under test, so it is waited for rather than read once.
    await expect
      .poll(() => heldUntil(page, workspace.id), { message: 'the server keeps the chosen end' })
      .not.toBeNull();
    const until = await heldUntil(page, workspace.id);
    const after = await serverClock(page);
    const kept = Date.parse(until ?? '');
    expect(kept).toBeGreaterThan(before + 119 * 60_000);
    expect(kept).toBeLessThan(after + 121 * 60_000);

    await page.reload();
    await shellReady(page);
    await expect(bar).toBeVisible();
    // Hold the real end request: the bar goes immediately, while the server still holds the start.
    // Reloading at that instant cancels the PUT; only the committed answer proves persistence.
    let releaseEnd: () => void = () => undefined;
    const mayEnd = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });
    let sawEnd: () => void = () => undefined;
    const endRequested = new Promise<void>((resolve) => {
      sawEnd = resolve;
    });
    await page.route(`**/api/workspaces/${workspace.id}/deep-work`, async (route) => {
      sawEnd();
      await mayEnd;
      await route.continue();
    });
    try {
      await palette(page, 'End Deep Work');
      await endRequested;
      await expect(bar).toHaveCount(0);
      expect(await heldUntil(page, workspace.id)).toBe(until);
      releaseEnd();
      await expect
        .poll(() => heldUntil(page, workspace.id), { message: 'the server keeps Deep Work ended' })
        .toBeNull();
      await page.reload();
      await shellReady(page);
      await expect(bar).toHaveCount(0);
    } finally {
      releaseEnd();
    }
  });

  test('started in one tab is drawn in the person’s other tab, and so is its end (#526)', async ({
    asOutsider,
    workspaceOf,
  }) => {
    const workspace = await workspaceOf('frank');
    const here = await asOutsider('frank');
    // Another tab of the same browser: the same person, its own socket.
    const there = await here.context().newPage();
    for (const page of [here, there]) {
      await page.goto(`/w/${workspace.slug}`);
      await shellReady(page);
    }
    const barOf = (page: Page): ReturnType<Page['getByRole']> =>
      page.getByRole('status').filter({ hasText: /Deep Work until/ });

    await palette(here, 'For 1 hour');
    await expect(barOf(here)).toBeVisible();
    await expect(barOf(there)).toBeVisible();

    await palette(here, 'End Deep Work');
    await expect(barOf(here)).toHaveCount(0);
    await expect(barOf(there)).toHaveCount(0);
  });
});
