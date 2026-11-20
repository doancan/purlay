/**
 * A channel muted for a while (D-329), against the real API: the end chosen from the bell is what the
 * server keeps, the bell says until when, the person's other tab is told, and "until tomorrow" is nine
 * the next morning on the viewer's own wall clock — here Istanbul's, which is not the run's UTC.
 *
 * In a channel of the test's own (`room`): a level is the person's own row, and nothing the seeded
 * channels draw for the screenshots changes.
 */
import type { Page } from '@playwright/test';
import type { Channel } from '@purlay/types';
import { expect, test } from './fixtures';
import { shellReady } from './support';

const ZONE = 'Europe/Istanbul';

/** The server's own clock, from its answer's `Date` header (whole seconds). */
const serverClock = async (page: Page): Promise<number> => {
  const response = await page.request.get('/api/me');
  return Date.parse(response.headers()['date'] ?? '');
};

/** The channel as the server answers it to this page's person. */
const channelOf = async (page: Page, channelId: string): Promise<Channel> =>
  (await (await page.request.get(`/api/channels/${channelId}`)).json()) as Channel;

/** The wall clock in Istanbul at an instant, `HH:mm`. */
const istanbulClock = (instant: string | number): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(instant));

const muteFor = async (page: Page, choice: RegExp): Promise<void> => {
  await page.getByRole('button', { name: /^Notifications:/ }).click();
  await page.getByRole('menuitem', { name: /Mute for/ }).click();
  await page.getByRole('menuitem', { name: choice }).click();
};

test.describe('muting a channel for a while', () => {
  test.use({ timezoneId: ZONE });

  test('for an hour: kept by the server, said by the bell, and told to the other tab', async ({
    page,
    signIn,
    room,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    const there = await page.context().newPage();
    for (const tab of [page, there]) {
      await tab.goto(made.path);
      await shellReady(tab);
    }

    const before = await serverClock(page);
    await muteFor(page, /^For 1 hour \(\d\d:\d\d\)$/);
    await expect
      .poll(async () => (await channelOf(page, made.id)).notificationLevelUntil ?? null, {
        message: 'the server keeps the chosen end',
      })
      .not.toBeNull();
    const kept = await channelOf(page, made.id);
    const after = await serverClock(page);
    expect(kept.notificationLevel).toBe('none');
    const until = Date.parse(kept.notificationLevelUntil ?? '');
    expect(until).toBeGreaterThan(before + 59 * 60_000);
    expect(until).toBeLessThan(after + 61 * 60_000);

    // Said on the viewer's own clock, in both tabs: the other one heard CHANNELS_UPDATED and read again.
    const said = `Notifications: nothing until ${istanbulClock(until)}`;
    await expect(page.getByRole('button', { name: said })).toBeVisible();
    await expect(there.getByRole('button', { name: said })).toBeVisible();
    await there.getByRole('button', { name: said }).click();
    await expect(there.getByText(`Muted until ${istanbulClock(until)}`)).toBeVisible();
    await there.keyboard.press('Escape');

    // Nothing, chosen again for good, ends the timer on the server and in the other tab.
    await page.getByRole('button', { name: said }).click();
    await page.getByRole('menuitemradio', { name: /Nothing/ }).click();
    await expect
      .poll(async () => (await channelOf(page, made.id)).notificationLevelUntil ?? null)
      .toBeNull();
    await expect(there.getByRole('button', { name: 'Notifications: nothing' })).toBeVisible();
    expect((await channelOf(page, made.id)).notificationLevel).toBe('none');
  });

  test('until tomorrow is nine the next morning in the viewer’s zone, within the bound', async ({
    page,
    signIn,
    room,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    await shellReady(page);

    const now = await serverClock(page);
    await muteFor(page, /^Until tomorrow$/);
    await expect
      .poll(async () => (await channelOf(page, made.id)).notificationLevelUntil ?? null)
      .not.toBeNull();
    const until = Date.parse((await channelOf(page, made.id)).notificationLevelUntil ?? '');
    expect(until).toBeGreaterThan(now);
    expect(until).toBeLessThanOrEqual(now + 24 * 3_600_000 + 1_000);
    // Nine in Istanbul — unless that is further than the server's 24 hours, which only happens when
    // it is chosen between five and nine there, and then the end is the bound.
    const hourThere = Number(istanbulClock(now).slice(0, 2));
    if (hourThere < 5 || hourThere >= 9) expect(istanbulClock(until)).toBe('09:00');
    else expect(until).toBeGreaterThan(now + 23 * 3_600_000);
  });

  test('an end the server refuses puts the level back and says why', async ({
    page,
    signIn,
    room,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    await shellReady(page);
    // A client clock a day ahead would ask for an end past the bound: the server's answer, forced here.
    await page.route(`**/api/channels/${made.id}/notification-level`, async (route) => {
      const asked = route.request().postDataJSON() as { until?: string };
      await route.continue({
        postData: JSON.stringify({
          level: 'none',
          until: new Date(Date.parse(asked.until ?? '') + 48 * 3_600_000).toISOString(),
        }),
      });
    });
    await muteFor(page, /^For 15 minutes/);
    await expect(page.getByText(/The notification level was not changed\./)).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Notifications: mentions and replies' }),
    ).toBeVisible();
    expect(await channelOf(page, made.id)).toMatchObject({
      notificationLevel: 'mentions',
      notificationLevelUntil: null,
    });
  });
});
