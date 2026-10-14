/**
 * Who is online (#480, D-136), in two real browsers: somebody who opens Purlay has the dot on their
 * avatar in People for the people they share a workspace with, said as "online" to a screen reader —
 * through the socket, the server's registry and the snapshot, which a component test cannot show.
 *
 * Offline after the grace, the version order and what is forgotten are the unit and integration
 * tests' (`realtime/online.test.ts`, `sockets.integration.test.ts`, `sidebar.test.tsx`): the grace is
 * half a minute, which a browser test would only wait out.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openNav } from './support';

/** People, in the sidebar wherever this width keeps it. */
const people = async (page: Page): Promise<Locator> =>
  (await openNav(page)).getByRole('region', { name: 'People' });

test.describe('who is online', () => {
  test('somebody who opens Purlay has a dot, and says so, for the others in the workspace', async ({
    page,
    signIn,
    room,
    asPerson,
    expectNoAxe,
  }) => {
    const made = await room();
    await signIn();
    await page.goto(made.path);
    // The person themselves, once connected.
    const section = await people(page);
    await expect(section.locator('li', { hasText: 'you' }).locator('[data-online]')).toHaveCount(1);

    const alice = await asPerson('alice');
    await alice.goto(made.path);
    const row = section.locator('li', { hasText: 'Alice' });
    await expect(row.locator('[data-online]')).toHaveCount(1);
    // What the dot says, in words: hidden from sight, read with her name.
    await expect(row).toContainText('Alice Chen, online');
    await expectNoAxe(section);
  });
});
