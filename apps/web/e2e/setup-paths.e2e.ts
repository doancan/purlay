/**
 * The paths the first walk of the wizard leaves out (`setup.e2e.ts`), on a server of their own — the
 * ones a real operator meets on the way to a working server, with a real mail relay that keeps what it
 * took (`fresh.ts`, the mailbox):
 *
 * - a sender with a name before it, said under its field, in words;
 * - the administrator's letter sent again — the new link opens, the old one no longer does;
 * - the invitation by email, and the invited person's whole way in on an invite-only server: the
 *   invitation link, an email sign-in link from the mailbox, *Join*, the workspace.
 *
 * Run narrow and dark: the first walk is wide and light, so together they hold both widths and both
 * themes of the wizard through to the end.
 */
import { expect, test } from '@playwright/test';
import { letterWith, linkIn, portFor, startFresh, type FreshServer } from './fresh';

const PORT = portFor(70);

let fresh: FreshServer | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, info) => {
  test.skip(info.project.name !== 'chromium-dark-narrow', 'one run, at the other width and theme');
  test.setTimeout(240_000);
  fresh = await startFresh(PORT);
});

test.afterAll(() => {
  fresh?.stop();
});

test('a sender with a name, the letter again, and an invited person by email', async ({
  browser,
}) => {
  if (fresh === null) throw new Error('the server did not start');
  const { origin, code, relay, mailbox } = fresh.manifest;
  const context = await browser.newContext({
    baseURL: origin,
    reducedMotion: 'reduce',
    colorScheme: 'dark',
    viewport: { width: 820, height: 900 },
  });
  const page = await context.newPage();

  await page.goto('/setup');
  await page.getByLabel('Setup code').fill(code);
  await page.keyboard.press('Enter');
  await page.getByLabel('Name', { exact: true }).fill('Ada Admin');
  await page.getByLabel('Email address').fill('ada@example.test');
  await page.getByLabel('Password', { exact: true }).fill('a long and unusual phrase 7');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: 'Confirm and continue' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();

  // The sender may not carry a name: the field says so, the page does not shrug.
  await expect(page.getByRole('heading', { level: 1, name: 'Connect email' })).toBeVisible();
  await page
    .getByLabel('Mail server', { exact: true })
    .fill(`smtp://127.0.0.1:${String(relay.port)}`);
  await page.getByLabel('Allow an unencrypted connection').check();
  await page.getByLabel('Sender').fill('Purlay <no-reply@example.test>');
  await page.getByRole('button', { name: 'Try the connection and continue' }).click();
  await expect(
    page.getByText('Use one plain address, such as purlay@example.com, with no name before it.'),
  ).toBeVisible();
  await expect(page.getByLabel('Sender')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('The server refused this. Try again.')).toHaveCount(0);

  await page.getByLabel('Sender').fill('no-reply@example.test');
  await page.getByRole('button', { name: 'Try the connection and continue' }).click();
  await expect(page.getByText(/We sent a message to ada@example.test/)).toBeVisible();

  // The letter again: the second link is the one that opens; the first has been replaced.
  const first = linkIn(
    await letterWith(mailbox, /Confirm your address/, 0),
    /\/setup\/verify#[0-9a-f]{64}/,
  );
  await page.getByRole('button', { name: 'Send the letter again' }).click();
  await expect(page.getByText(/We sent it again to ada@example.test/)).toBeVisible();
  const second = linkIn(
    await letterWith(mailbox, /Confirm your address/, 1),
    /\/setup\/verify#[0-9a-f]{64}/,
  );
  expect(second).not.toBe(first);

  const reader = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  const reading = await reader.newPage();
  await reading.goto(first);
  await expect(reading.getByRole('heading', { name: 'This link does not open' })).toBeVisible();
  // A second tab, as a person opens a second link: the same page with another fragment would not reload.
  const again = await reader.newPage();
  await again.goto(second);
  await expect(again.getByRole('heading', { name: 'Your address is verified' })).toBeVisible();
  await reader.close();

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Kokil Metal');
  await page.getByRole('button', { name: 'Create workspace' }).click();

  // The invitation by email, the way a team is started.
  await expect(page.getByRole('heading', { level: 1, name: 'Invite your team' })).toBeVisible();
  const addresses = page.getByRole('textbox', { name: 'Email addresses' });
  await addresses.fill('ayse@example.test,');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(
    page.getByText('Asked the mail server to send the invitation to 1 person.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page).toHaveURL(/\/w\/kokil-metal/);

  // The invited person, in a browser that holds nothing, on a server that makes accounts by invitation.
  const invitation = await letterWith(mailbox, /You have been invited/);
  const invite = linkIn(invitation, /\/invite#[0-9a-f]{64}/);
  const invitee = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  const guest = await invitee.newPage();
  await guest.goto(invite);
  await expect(guest.getByRole('heading', { name: 'You have been invited' })).toBeVisible();
  await guest.getByRole('textbox', { name: 'Email address' }).fill('ayse@example.test');
  await guest.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(guest.getByText(/a link is on its way/)).toBeVisible();
  const signIn = linkIn(
    await letterWith(mailbox, /Your sign-in link/),
    /\/sign-in\/email#[0-9A-Za-z_-]+/,
  );
  await guest.goto(signIn);
  await expect(guest.getByText('You are signing in as ayse@example.test.')).toBeVisible();
  await guest.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(guest.getByRole('heading', { name: 'Join Kokil Metal' })).toBeVisible();
  await guest.getByRole('button', { name: 'Join' }).click();
  await expect(guest).toHaveURL(/\/w\/kokil-metal\/welcome/);
  await invitee.close();

  // And the administrator sees the new member.
  await page.goto('/w/kokil-metal/settings/members');
  await expect(page.getByText('@ayse')).toBeVisible();
  await context.close();
});
