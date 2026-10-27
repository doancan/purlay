/**
 * The first run, the way the first people on a new server live it — through the page, every step a
 * person takes, nothing under test done over the API.
 *
 * Three people of the test's own (`newcomer`), each in their own browser, none in a workspace; the
 * server the suite runs lets anybody make one (`WORKSPACE_CREATORS: '*'`). The first makes a workspace
 * with the form `/` shows, lands in the channel it starts with (D-174), makes a link from the workspace
 * menu (D-115); the second opens it, joins, is offered that channel on the welcome step (D-132), joins it
 * and writes; the first sees the words arrive. The third opened nothing: the form is theirs too, and the
 * workspace is not.
 */
import type { Locator, Page } from '@playwright/test';
import { DEFAULT_CHANNEL_NAME } from '@purlay/types';
import { expect, test } from './fixtures';
import { openNav } from './support';

const composer = (page: Page): Locator =>
  page.getByRole('textbox', { name: `Message ${DEFAULT_CHANNEL_NAME}` });

const rowWith = (page: Page, text: string): Locator =>
  page.locator('[data-message-row]', { hasText: text });

test.describe('the first run', () => {
  test('a workspace made, a person invited by a link, and the first words between them', async ({
    newcomer,
    expectNoAxe,
  }) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const name = `First run ${suffix}`;
    const slug = `first-run-${suffix}`;

    // ── The first person: nothing yet, and the form to make it ──────────────────────────────────
    const founder = await newcomer('founder');
    const first = await founder.page();
    await first.goto('/');
    await expect(
      first.getByRole('heading', { level: 1, name: 'You are not in a workspace yet' }),
    ).toBeVisible();
    await expectNoAxe(first.getByRole('main'));
    await first.getByLabel('Name').fill(name);
    // The address is suggested from the name, and is what is sent.
    await expect(first.getByLabel('Address')).toHaveValue(slug);
    await first.getByRole('button', { name: 'Create workspace' }).click();

    // ── In the channel it starts with — not an empty workspace, not a list of channels to pick ──
    await expect(first).toHaveURL(new RegExp(`/w/${slug}/c/[0-9a-f-]{36}$`));
    const general = new URL(first.url()).pathname;
    await expect(
      first.getByRole('heading', { level: 1, name: DEFAULT_CHANNEL_NAME, exact: true }),
    ).toBeVisible();
    await expect(composer(first)).toBeVisible();
    await expect(first.getByRole('heading', { name: 'Pick a channel' })).toHaveCount(0);

    // ── A link, from the workspace menu ──────────────────────────────────────────────────────────
    await openNav(first);
    await first.getByRole('button', { name: 'Switch workspace' }).click();
    await first.getByRole('menuitem', { name: 'Invite people…' }).click();
    const dialog = first.getByRole('dialog', { name: `Invite people to ${name}` });
    await dialog.getByRole('button', { name: 'Make a link' }).click();
    const field = dialog.getByRole('textbox', { name: 'Invitation link' });
    await expect(field).toHaveValue(/\/invite#[0-9a-f]{64}$/);
    await expectNoAxe(dialog);
    const link = new URL(await field.inputValue());
    await first.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // On a narrow window the navigation it was opened from is still over the channel: closed too.
    const navigation = first.getByRole('dialog', { name: 'Workspace' });
    if (await navigation.isVisible()) await first.keyboard.press('Escape');
    await expect(navigation).toHaveCount(0);
    // Still where the words will arrive.
    await expect(first).toHaveURL(new RegExp(`${general}$`));
    await expect(composer(first)).toBeVisible();

    // ── The second person opens it, in a browser of their own ───────────────────────────────────
    const joiner = await newcomer('joiner');
    const second = await joiner.page();
    await second.goto(link.pathname + link.hash);
    await expect(second.getByRole('heading', { name: `Join ${name}` })).toBeVisible();
    await expectNoAxe(second.getByRole('main'));
    await second.getByRole('button', { name: 'Join', exact: true }).click();

    // The welcome step offers the channel the workspace started with; silent, it is not picked.
    await expect(second).toHaveURL(new RegExp(`/w/${slug}/welcome$`));
    const offered = second.getByRole('checkbox', { name: `#${DEFAULT_CHANNEL_NAME}` });
    await expect(offered).not.toBeChecked();
    await expectNoAxe(second.getByRole('main'));
    await offered.check();
    await second.getByRole('button', { name: 'Join 1 channel' }).click();
    await expect(second).toHaveURL(new RegExp(`${general}$`));

    // The founder already cached the workspace's member list before the invitee joined.
    // Add that genuinely new member without a reload or a visit to the members screen.
    const channelName = `first-team-${suffix}`;
    await (await openNav(first)).getByRole('button', { name: 'New channel' }).click();
    await first.getByLabel('Name', { exact: true }).fill(channelName);
    await first.getByRole('button', { name: 'Create channel' }).click();
    await expect(first.getByRole('heading', { name: channelName, exact: true })).toBeVisible();
    await first.getByRole('button', { name: 'Add people' }).click();
    const people = first.getByRole('dialog', { name: `Add people to ${channelName}` });
    await people.getByLabel('Find a person').fill(joiner.username);
    await people.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(people.getByRole('button', { name: 'Added' })).toBeDisabled();
    await first.keyboard.press('Escape');
    await first.goto(general);
    await expect(composer(first)).toBeVisible();

    // ── The second writes; the first sees it, live ───────────────────────────────────────────────
    const words = `hello from the second person ${suffix}`;
    await composer(second).fill(words);
    await composer(second).press('Enter');
    await expect(rowWith(second, words)).toBeVisible();
    await expect(rowWith(first, words)).toBeVisible();
    // Under the name of who wrote them — shown as a name, capitalised.
    await expect(rowWith(first, words)).toContainText(new RegExp(joiner.username, 'i'));

    // ── A third person who opened nothing: the form is theirs too, and the workspace is not ─────
    const bystander = await newcomer('bystander');
    const third = await bystander.page();
    await third.goto('/');
    await expect(
      third.getByRole('heading', { level: 1, name: 'You are not in a workspace yet' }),
    ).toBeVisible();
    await expect(third.getByRole('button', { name: 'Create workspace' })).toBeVisible();
    await expect(third).toHaveURL(/\/$/);
    // Its address leads nowhere for them, as a workspace that does not exist would.
    await third.goto(`/w/${slug}`);
    await expect(third.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
    await expect(third.getByText(name)).toHaveCount(0);
    const theirs = await bystander.api.get<{ workspace: { slug: string } }[]>('/api/workspaces');
    expect(theirs).toEqual([]);
  });
});
