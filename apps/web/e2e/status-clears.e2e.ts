/**
 * A status line that clears itself (D-330), the whole way: a newcomer sets words in Turkish, an emoji and "Clear
 * after" on Profile, in Istanbul's zone; the server keeps the end the choice comes to on that clock, and Bob — in a
 * conversation with them, already open — sees the emoji and the words at once.
 *
 * A newcomer of the test's own, in a workspace of the test's own: the seeded people, whom the screenshots and the
 * profile test draw, keep theirs. Their browser is a context of its own in Istanbul's zone, carrying their session,
 * so the run's UTC is not the zone under test.
 */
import type { Page } from '@playwright/test';
import type { Profile } from '@purlay/types';
import { expect, test } from './fixtures';
import { apiAs, isNarrow, shellReady, skipReleaseNotes } from './support';

const ZONE = 'Europe/Istanbul';
/** Istanbul keeps UTC+3 all year (no clock changes since 2016). */
const ISTANBUL_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

/** The server's own clock, from its answer's `Date` header (whole seconds). */
const serverClock = async (page: Page): Promise<number> =>
  Date.parse((await page.request.get('/api/me')).headers()['date'] ?? '');

const profileOf = async (page: Page): Promise<Profile> =>
  ((await (await page.request.get('/api/me')).json()) as { profile: Profile }).profile;

test.describe('a status line that clears itself', () => {
  test('set on Profile in Istanbul: kept with its end, and shown to the other person at once', async ({
    tenant,
    asPerson,
    newcomer,
    browser,
    baseURL,
  }) => {
    const bob = apiAs(tenant, 'bob');
    const person = await newcomer('clears-status');
    const slug = `status-${crypto.randomUUID().slice(0, 8)}`;
    const workspace = await bob.post<{ id: string }>('/api/workspaces', { name: 'Status', slug });
    const { token } = await bob.post<{ token: string }>(
      `/api/workspaces/${workspace.id}/invitations`,
    );
    await person.api.post('/api/invitations/accept', { token });
    const conversation = await bob.post<{ id: string }>(
      `/api/workspaces/${workspace.id}/conversations`,
      { userIds: [person.userId] },
    );
    const watcher = await asPerson('bob');
    await watcher.goto(`/w/${slug}/c/${conversation.id}`);
    await shellReady(watcher);

    // Their session, in a browser whose clock is Istanbul's.
    const signedIn = await person.page();
    const context = await browser.newContext({
      ...(baseURL === undefined ? {} : { baseURL }),
      timezoneId: ZONE,
      locale: 'en-GB',
    });
    await skipReleaseNotes(context);
    await context.addCookies(await signedIn.context().cookies());
    const page = await context.newPage();
    await page.goto(`/w/${slug}/settings/profile`);
    const form = page.getByRole('main');
    await expect(form.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
    // The form the status is in: a newcomer's own name has a Save of its own above it (D-235).
    const save = form
      .locator('form')
      .filter({ has: page.getByRole('textbox', { name: 'Status', exact: true }) })
      .getByRole('button', { name: 'Save' });

    // An emoji that is not one is refused on its field, and nothing is kept.
    await form.getByRole('textbox', { name: 'Status', exact: true }).fill('Öğle yemeğinde');
    await form.getByRole('textbox', { name: 'Emoji' }).fill('lunch');
    await save.click();
    await expect(form.getByText('That is not one emoji.')).toBeVisible();
    expect((await profileOf(page)).status).toBeNull();

    // One hour: the server keeps an end an hour from its own clock.
    const before = await serverClock(page);
    await form.getByRole('textbox', { name: 'Emoji' }).fill('🍽️');
    await form.getByRole('combobox', { name: 'Clear after' }).selectOption('1h');
    await save.click();
    await expect(form.getByRole('status')).toHaveText('Saved.');
    const kept = await profileOf(page);
    const after = await serverClock(page);
    expect(kept).toMatchObject({ status: 'Öğle yemeğinde', statusEmoji: '🍽️' });
    const end = Date.parse(kept.statusUntil ?? '');
    expect(end).toBeGreaterThan(before + 59 * 60_000);
    expect(end).toBeLessThan(after + 61 * 60_000);

    // Bob's open conversation reads the members again on the change: the emoji and the words, no reload.
    if (!isNarrow(watcher)) {
      await expect(watcher.locator('header').first().getByText('🍽️ Öğle yemeğinde')).toBeVisible();
    }
    await watcher.getByRole('heading', { level: 1 }).getByRole('button').click();
    const panel = watcher.getByRole('complementary', { name: /^Profile/ });
    await expect(panel.getByText('🍽️ Öğle yemeğinde')).toBeVisible();
    // The clock time on the viewer's own day, the whole date and time on another (`untilText`): an hour from the last
    // hour of the day is the next one, so both are the end this line says.
    await expect(panel.getByText(/^Until (\d\d:\d\d|.+\d{1,2}:\d\d.*)$/)).toBeVisible();

    // Today: the end is Istanbul's next midnight, not UTC's.
    const now = await serverClock(page);
    await form.getByRole('combobox', { name: 'Clear after' }).selectOption('today');
    await save.click();
    await expect(form.getByRole('status')).toHaveText('Saved.');
    const midnight =
      Math.floor((now + ISTANBUL_OFFSET_MS) / DAY_MS) * DAY_MS + DAY_MS - ISTANBUL_OFFSET_MS;
    expect((await profileOf(page)).statusUntil).toBe(new Date(midnight).toISOString());
    await context.close();
  });
});
