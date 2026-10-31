/**
 * Two-step verification through the screens, against a real server (D-236, `UX.md` §11): the setup's
 * administrator — the account with a password — turns it on in Sessions & account with a code worked out here
 * from the key on the page, as an authenticator app would; then, in a browser of its own, the password alone no
 * longer signs in: the form asks for the code, a wrong one is refused, the right one signs in, and a backup code
 * signs in once.
 *
 * Its own server and scratch database (`fresh.ts`); run once, dark and wide, since the other specs of a fresh
 * server hold the light and the narrow.
 */
import { createHmac } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { portFor, startFresh, type FreshServer } from './fresh';
import { wallClock } from './support';

const PORT = portFor(90);
const EMAIL = 'ayse@example.test';
const PASSWORD = 'a long and unusual phrase 7';

let fresh: FreshServer | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, info) => {
  test.skip(info.project.name !== 'chromium-dark', 'one run proves the path');
  test.setTimeout(240_000);
  fresh = await startFresh(PORT);
});

test.afterAll(() => {
  fresh?.stop();
});

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 6238 from the key as the page shows it (base32, in groups), as an authenticator app works it out. */
const codeFor = (shownKey: string, steps = 0): string => {
  const bits = shownKey
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/./g, (letter) => BASE32.indexOf(letter).toString(2).padStart(5, '0'));
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(wallClock().getTime() / 30_000) + steps));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
};

/** A browser with nobody in it, at the sign-in screen, after a right password. */
const askedForTheCode = async (browser: Browser, origin: string): Promise<Page> => {
  const context = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByRole('textbox', { name: 'Email address' }).fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('form', { name: 'Two-step verification' })).toBeVisible();
  // Nobody is signed in yet: the password alone opened nothing.
  expect((await page.request.get('/api/me')).status()).toBe(401);
  return page;
};

test('the administrator turns it on, and then signs in with the password and a code', async ({
  browser,
}) => {
  if (fresh === null) throw new Error('the server did not start');
  const { origin, code, github } = fresh.manifest;
  const context = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  const send = async (path: string, data?: unknown): Promise<void> => {
    const response = await context.request.post(path, { data, headers: { origin } });
    expect(response.ok(), `${path}: ${String(response.status())} ${await response.text()}`).toBe(
      true,
    );
  };
  await send('/setup/claim', { code });
  await send('/setup/admin', { name: 'Ayse Demir', email: EMAIL, password: PASSWORD });
  await send('/setup/address', { confirmed: true });
  await send('/setup/policy', { signUp: 'invite-only' });
  await send('/setup/github', {
    clientId: github.clientId,
    clientSecret: github.clientSecret,
    save: true,
  });
  await send('/setup/smtp', { skip: true });
  await send('/setup/workspace', { name: 'Acme Engineering', slug: 'acme-engineering' });
  await send('/setup/invite');
  await send('/setup/finish');

  // Turning it on: the password, the key, a right code, the backup codes once.
  const page = await context.newPage();
  await page.goto('/w/acme-engineering/settings/account');
  const card = page.getByRole('region', { name: 'Two-step verification' });
  await expect(card.getByText('Off', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Turn on…' }).click();
  await card.getByLabel('Your password').fill(PASSWORD);
  await card.getByRole('button', { name: 'Continue' }).click();
  await expect(card.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  const link = await card
    .getByRole('link', { name: 'Open in an authenticator app on this device' })
    .getAttribute('href');
  expect(link?.startsWith('otpauth://totp/Purlay%20(')).toBe(true);
  const shownKey = new URL(link ?? '').searchParams.get('secret') ?? '';
  await expect(card.getByText(shownKey.replace(/(.{4})(?=.)/g, '$1 '))).toBeVisible();
  await card.getByLabel('Code from the app').fill(codeFor(shownKey));
  await card.getByRole('button', { name: 'Turn on' }).click();
  const codes = card.getByRole('region', { name: 'Backup codes' }).getByRole('listitem');
  await expect(codes).toHaveCount(10);
  const backupCode = (await codes.first().textContent()) ?? '';
  await card.getByRole('button', { name: 'Done' }).click();
  await expect(card.getByText('On', { exact: true })).toBeVisible();
  // The tab that turned it on is still signed in, on the same session.
  expect((await page.request.get('/api/me')).status()).toBe(200);

  // Another browser: the password, then a wrong code, then the right one.
  const signingIn = await askedForTheCode(browser, origin);
  await signingIn.getByLabel('Code').fill(codeFor(shownKey, 5));
  await signingIn.getByRole('button', { name: 'Verify' }).click();
  await expect(signingIn.getByText('That code is not right. Try again.')).toBeVisible();
  await signingIn.getByLabel('Code').fill(codeFor(shownKey));
  await signingIn.getByRole('button', { name: 'Verify' }).click();
  await expect(signingIn).not.toHaveURL(/\/sign-in/);
  expect((await signingIn.request.get('/api/me')).status()).toBe(200);
  await signingIn.context().close();

  // A backup code signs in once.
  const withBackup = await askedForTheCode(browser, origin);
  await withBackup.getByRole('button', { name: 'Use a backup code instead' }).click();
  await withBackup.getByLabel('Backup code').fill(backupCode);
  await withBackup.getByRole('button', { name: 'Verify' }).click();
  await expect(withBackup).not.toHaveURL(/\/sign-in/);
  await withBackup.context().close();
  const spent = await askedForTheCode(browser, origin);
  await spent.getByRole('button', { name: 'Use a backup code instead' }).click();
  await spent.getByLabel('Backup code').fill(backupCode);
  await spent.getByRole('button', { name: 'Verify' }).click();
  await expect(spent.getByText('That code is not right. Try again.')).toBeVisible();
  await spent.context().close();
  await context.close();
});
