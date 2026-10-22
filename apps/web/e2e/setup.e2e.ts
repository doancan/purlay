/**
 * The setup wizard against a real server nobody has set up (D-179 §4, `UX.md` §11): a scratch
 * database with no one in it, GitHub's strict stand-in and a mail relay on loopback ports, and the
 * API serving the built client (`apps/api/src/testing/fresh-server.ts`) — the demo's world has people,
 * so it cannot be the place a setup runs.
 *
 * One path, once: the code, the administrator, the address, GitHub tried and kept, the relay, the
 * workspace, the invitation link, finish, and the app. Every other screen and refusal is the
 * component tests' (`features/setup/*.test.tsx`); the full acceptance — including the invitee, the
 * sign-out and the password sign-in again — is the end-to-end spec that closes the setup work.
 *
 * Its own server and database, outside the four projects' worlds; it runs once, in the light wide
 * project, since a second run in each of the others would only repeat what one proves.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

interface Manifest {
  readonly origin: string;
  readonly code: string;
  readonly github: { readonly clientId: string; readonly clientSecret: string };
  readonly relay: { readonly port: number };
}

// Clear of the four worlds (`BASE_PORT + 100 × index`) and of a person's own demo.
const PORT = Number(process.env['PURLAY_E2E_PORT'] ?? 4173) + 50;

let server: ChildProcess | null = null;
let directory = '';
let manifest: Manifest | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, info) => {
  test.skip(info.project.name !== 'chromium-light', 'one run proves the path');
  test.setTimeout(240_000);
  directory = mkdtempSync(join(tmpdir(), 'purlay-setup-e2e-'));
  const file = join(directory, 'fresh.json');
  server = spawn(
    'bun',
    [
      'run',
      'apps/api/src/testing/fresh-server.ts',
      '--no-build',
      '--db',
      `purlay_e2e_fresh_${String(PORT)}`,
      '--port',
      String(PORT),
      '--manifest',
      file,
    ],
    { cwd: '../..', stdio: 'ignore' },
  );
  for (let attempt = 0; attempt < 1200 && !existsSync(file); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
});

test.afterAll(() => {
  server?.kill();
  if (directory !== '') rmSync(directory, { recursive: true, force: true });
});

test('walks a fresh server from the code to its first workspace', async ({ browser }) => {
  if (manifest === null) throw new Error('the server did not start');
  const { origin, code, github, relay } = manifest;
  const context = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  const page = await context.newPage();

  // `/` on a server nobody has set up is the wizard.
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);

  await expect(page.getByRole('heading', { level: 1, name: 'Enter the setup code' })).toBeVisible();
  await page.getByLabel('Setup code').fill('AAAA-BBBB');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/That is not the setup code/)).toBeVisible();
  await page.getByLabel('Setup code').fill(code);
  await page.keyboard.press('Enter');

  await expect(
    page.getByRole('heading', { level: 1, name: /administrator account/ }),
  ).toBeFocused();
  await page.getByLabel('Name', { exact: true }).fill('Ayse Demir');
  await page.getByLabel('Email address').fill('ayse@example.test');
  await page.getByLabel('Password', { exact: true }).fill('a long and unusual phrase 7');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: 'Confirm the server address' }),
  ).toBeVisible();
  await expect(page.getByText(`${origin}/auth/callback/github`)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm and continue' }).click();

  // GitHub: a wrong secret is refused in GitHub's words; the right pair is accepted, then kept.
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in with GitHub' })).toBeVisible();
  await page.getByLabel('Client ID').fill(github.clientId);
  await page.getByLabel('Client secret').fill('wrong-secret');
  await page.getByRole('button', { name: 'Try it' }).click();
  await expect(page.getByText('GitHub knows the app and refused the client secret.')).toBeVisible();
  await expect(page.getByText('incorrect_client_credentials')).toBeVisible();
  await page.getByLabel('Client secret').fill(github.clientSecret);
  await page.getByRole('button', { name: 'Try it' }).click();
  await expect(page.getByText('GitHub accepted these credentials.')).toBeVisible();
  await page.getByRole('button', { name: 'Save and continue' }).click();

  // Email: the letter is the try. A closed port is refused; the relay takes the letter.
  await expect(page.getByRole('heading', { level: 1, name: 'Connect email' })).toBeVisible();
  await page.getByLabel('Mail server', { exact: true }).fill('smtp://127.0.0.1:1');
  await page.getByLabel('Sender').fill('no-reply@example.test');
  await page.getByLabel('Allow an unencrypted connection').check();
  await page.getByRole('button', { name: 'Try the connection and continue' }).click();
  await expect(page.getByText('Nothing answered at that address, or not in time.')).toBeVisible();
  await page
    .getByLabel('Mail server', { exact: true })
    .fill(`smtp://127.0.0.1:${String(relay.port)}`);
  await page.getByRole('button', { name: 'Try the connection and continue' }).click();
  await expect(page.getByText(/We sent a message to ayse@example.test/)).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: 'Create the first workspace' }),
  ).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Acme Engineering');
  await page.getByRole('button', { name: 'Create workspace' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Invite your team' })).toBeVisible();
  await page.getByRole('button', { name: 'Make an invitation link' }).click();
  await expect(page.getByText(`${origin}/invite#`, { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Finish setup' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finish setup' })).toBeEnabled();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page).toHaveURL(/\/w\/acme-engineering/);

  // The door is closed from then on, and says so.
  await page.goto('/setup');
  await expect(
    page.getByRole('heading', { level: 1, name: 'This server is set up' }),
  ).toBeVisible();
  await context.close();

  // Out and in again with the password (R30): a browser that holds nothing signs the administrator in
  // — a wrong password first, in the one sentence that does not say whether the address exists.
  const returning = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  const again = await returning.newPage();
  await again.goto('/sign-in');
  const methods = await again.request.get('/api/auth/methods');
  expect(await methods.json()).toEqual({ github: true, email: true, signUp: 'invite-only' });
  await expect(again.getByText('Accounts are created by invitation.')).toBeVisible();
  await again.getByLabel('Email address').fill('ayse@example.test');
  await again.getByLabel('Password', { exact: true }).fill('not the password at all 1');
  await again.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(again.getByRole('alert')).toHaveText('Wrong email or password.');
  await again.getByLabel('Password', { exact: true }).fill('a long and unusual phrase 7');
  await again.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(again).toHaveURL(/\/w\/acme-engineering/);
  await returning.close();
});
