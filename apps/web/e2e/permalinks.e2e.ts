/**
 * A link to a message, the whole way (D-149): an address naming a message far older than the
 * newest page opens the channel at it — in view, marked for a moment, focused — with the way back to
 * the present; and Copy link on one's own message puts that address on the clipboard.
 *
 * Each test makes a room of its own (`support.ts`): the four projects share one database.
 */
import { expect, test } from './fixtures';
import { shellReady } from './support';

/** More than the window holds after the message (25 a side), so the window stops short of the present. */
const LATER = 40;

test.describe('a link to a message', () => {
  test('opens the channel at an old message, marked, with the way back to the present', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const here = await room({ members: ['dogancan', 'carol', 'bob'] });
    const old = await api('carol').say(here.id, `the decision about ${here.name}`);
    for (let n = 0; n < LATER; n += 1) {
      await api(n % 2 === 0 ? 'bob' : 'carol').say(here.id, `later note ${String(n)}`);
    }

    await signIn();
    await page.goto(`${here.path}?message=${old.id}`);
    await shellReady(page);
    const row = page.locator(`[role="feed"] [data-message-id="${old.id}"]`);
    await expect(row).toBeInViewport();
    await expect(row).toHaveAttribute('data-landed', '');
    await expect(row).toBeFocused();
    const back = page.getByRole('button', { name: 'Jump to recent' });
    await expect(back).toBeVisible();
    // A moment, then the mark lets go; the reader stays where they are.
    await expect(row).not.toHaveAttribute('data-landed', { timeout: 5_000 });
    await expect(row).toBeInViewport();

    await back.click();
    await expect(page).toHaveURL(new RegExp(`/c/${here.id}$`));
    await expect(page.getByText(`later note ${String(LATER - 1)}`)).toBeInViewport();
  });

  test('Copy link on one’s own message puts its whole address on the clipboard, which opens it', async ({
    page,
    context,
    signIn,
    room,
    api,
  }) => {
    test.skip(
      test.info().project.name !== 'chromium-dark',
      'one engine is enough, and the clipboard permission is Chromium’s to grant',
    );
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const here = await room({ members: ['dogancan', 'carol'] });
    const mine = await api('dogancan').say(here.id, `my note on ${here.name}`);

    await signIn();
    await page.goto(here.path);
    await shellReady(page);
    const row = page.locator(`[role="feed"] [data-message-id="${mine.id}"]`);
    await row.hover();
    await row.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Copy link' }).click();
    await expect(page.getByText('Link copied')).toBeVisible();
    const copied = await page.evaluate(async () => await navigator.clipboard.readText());
    expect(copied).toBe(new URL(`${here.path}?message=${mine.id}`, page.url()).href);

    await page.goto(copied);
    await expect(page.locator(`[role="feed"] [data-message-id="${mine.id}"]`)).toHaveAttribute(
      'data-landed',
      '',
    );
  });
});
