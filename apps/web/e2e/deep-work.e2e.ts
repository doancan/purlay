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
  await dialog.getByRole('option', { name: new RegExp(choose) }).click();
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

    const started = performance.timeOrigin + performance.now();
    await palette(page, 'For 2 hours');
    const bar = page.getByRole('status').filter({ hasText: /Deep Work until/ });
    await expect(bar).toBeVisible();

    // What the server holds is two hours from when it was asked, not the shortcut's one.
    const me = (await (await page.request.get('/api/me')).json()) as {
      memberships: { workspace: { id: string }; deepWorkUntil: string | null }[];
    };
    const until = me.memberships.find((m) => m.workspace.id === workspace.id)?.deepWorkUntil;
    const ahead = Date.parse(until ?? '') - started;
    expect(ahead).toBeGreaterThan(119 * 60_000);
    expect(ahead).toBeLessThan(121 * 60_000);

    await page.reload();
    await shellReady(page);
    await expect(bar).toBeVisible();
    await palette(page, 'End Deep Work');
    await expect(bar).toHaveCount(0);
    await page.reload();
    await shellReady(page);
    await expect(bar).toHaveCount(0);
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
