/**
 * The sign-in policy through the screens, against a real server (D-239, `UX.md` §11): the setup's administrator
 * — the account with a password — requires two-step verification on Settings → Server, and is at once held back:
 * the page shows only the card that turns it on, and the server refuses the rest. Turned on with a code worked out
 * here from the key on the page, as an authenticator app would, the same tab carries on, with no sign-in again.
 * Then password sign-in goes off while GitHub serves: a new browser is offered no password form, the server
 * refuses one, and the last way in is not offered to be disconnected.
 *
 * Its own server and scratch database (`fresh.ts`); run once, light and wide.
 */
import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { portFor, startFresh, type FreshServer } from './fresh';
import { wallClock } from './support';

const PORT = portFor(110);
const EMAIL = 'ayse@example.test';
const PASSWORD = 'a long and unusual phrase 7';

let fresh: FreshServer | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, info) => {
  test.skip(info.project.name !== 'chromium-light', 'one run proves the path');
  test.setTimeout(240_000);
  fresh = await startFresh(PORT);
});

test.afterAll(() => {
  fresh?.stop();
});

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 6238 from the key as the page shows it, as an authenticator app works it out. */
const codeFor = (shownKey: string): string => {
  const bits = shownKey
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/./g, (letter) => BASE32.indexOf(letter).toString(2).padStart(5, '0'));
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(wallClock().getTime() / 30_000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
};

test('the administrator requires two-step verification, is held back until it is on, then turns passwords off', async ({
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

  // Required: the administrator's own account has a password and no second step, so it is held back at once.
  const page = await context.newPage();
  await page.goto('/w/acme-engineering/settings/server');
  const policy = page.getByRole('region', { name: 'How people sign in' });
  await policy.getByRole('radio', { name: /Required/ }).check();
  const heading = page.getByRole('heading', { level: 1, name: 'Turn on two-step verification' });
  await expect(heading).toBeVisible();
  const held = await page.request.get('/api/workspaces');
  expect(held.status()).toBe(403);
  expect(((await held.json()) as { error: { code: string } }).error.code).toBe(
    'TWO_FACTOR_REQUIRED',
  );
  expect((await page.request.get('/api/me')).status()).toBe(200);
  // Anywhere in the application, the same screen.
  await page.goto('/w/acme-engineering');
  await expect(heading).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  // Turned on here: the password, the key, a right code, the backup codes once.
  const card = page.getByRole('region', { name: 'Two-step verification' });
  await expect(card.getByRole('button', { name: 'Turn off…' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Turn on…' }).click();
  await card.getByLabel('Your password').fill(PASSWORD);
  await card.getByRole('button', { name: 'Continue' }).click();
  const link = await card
    .getByRole('link', { name: 'Open in an authenticator app on this device' })
    .getAttribute('href');
  const shownKey = new URL(link ?? '').searchParams.get('secret') ?? '';
  await card.getByLabel('Code from the app').fill(codeFor(shownKey));
  await card.getByRole('button', { name: 'Turn on' }).click();
  await expect(
    card.getByRole('region', { name: 'Backup codes' }).getByRole('listitem'),
  ).toHaveCount(10);
  // The codes stay until Done, whatever the server would now allow.
  await expect(heading).toBeVisible();
  await card.getByRole('button', { name: 'Done' }).click();

  // The same tab, the same session: the workspace, and every route answers again.
  await expect(heading).toHaveCount(0);
  await expect(page.getByText('Acme Engineering').first()).toBeVisible();
  expect((await page.request.get('/api/workspaces')).status()).toBe(200);

  // Passwords off, while GitHub serves.
  await page.goto('/w/acme-engineering/settings/server');
  await policy.getByRole('radio', { name: /^Off/ }).check();
  await expect(policy.getByText('Saved. It applies from the next request.')).toBeVisible();
  const methods = (await (await page.request.get('/api/auth/methods')).json()) as {
    password: boolean;
  };
  expect(methods.password).toBe(false);

  // GitHub is now the last way in: not offered to be disconnected.
  await page
    .getByRole('region', { name: 'Sign in with GitHub' })
    .getByRole('button', { name: 'Disconnect' })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/Password sign-in is off/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Disconnect/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // A new browser: no password form, and the server refuses a password all the same.
  const stranger = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  const signIn = await stranger.newPage();
  await signIn.goto('/sign-in');
  await expect(signIn.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();
  await expect(signIn.getByLabel('Password', { exact: true })).toHaveCount(0);
  const refused = await signIn.request.post('/auth/sign-in/email', {
    data: { email: EMAIL, password: PASSWORD },
    headers: { origin },
  });
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { code: string }).code).toBe('PASSWORD_SIGN_IN_DISABLED');
  await stranger.close();
  await context.close();
});
