/**
 * Settings → Server against a real server (D-179 §4.8, `UX.md` §11): the setup is finished through the
 * API — the wizard's own screens are `setup.e2e.ts`'s — and then the administrator, in the browser,
 * replaces GitHub's app (a wrong secret refused in GitHub's words and nothing kept, the right one kept),
 * changes who may sign up, and is asked before the last way in is disconnected. A caller who is not the
 * administrator is told the route does not exist.
 *
 * Its own server and database, outside the four projects' worlds; it runs once, in the light wide project.
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

// Clear of the four worlds, of the setup's own server and of a person's demo.
const PORT = Number(process.env['PURLAY_E2E_PORT'] ?? 4173) + 60;

let server: ChildProcess | null = null;
let directory = '';
let manifest: Manifest | null = null;

test.beforeAll(async ({}, info) => {
  test.skip(info.project.name !== 'chromium-light', 'one run proves the path');
  test.setTimeout(240_000);
  directory = mkdtempSync(join(tmpdir(), 'purlay-server-e2e-'));
  const file = join(directory, 'fresh.json');
  server = spawn(
    'bun',
    [
      '--no-env-file',
      'run',
      'apps/api/src/testing/fresh-server.ts',
      '--no-build',
      '--db',
      `purlay_e2e_server_${String(PORT)}`,
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

test('the administrator replaces GitHub, changes the sign-up policy, and is asked before the last way in goes', async ({
  browser,
}) => {
  if (manifest === null) throw new Error('the server did not start');
  const { origin, code, github } = manifest;
  const context = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });

  // The setup, finished through the API: the administrator ends up signed in.
  const send = async (path: string, data?: unknown): Promise<void> => {
    const response = await context.request.post(path, { data, headers: { origin } });
    expect(response.ok(), `${path}: ${String(response.status())} ${await response.text()}`).toBe(
      true,
    );
  };
  await send('/setup/claim', { code });
  await send('/setup/admin', {
    name: 'Ayse Demir',
    email: 'ayse@example.test',
    password: 'a long and unusual phrase 7',
  });
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

  const page = await context.newPage();
  await page.goto('/w/acme-engineering/settings/server');
  await expect(page.getByRole('heading', { level: 1, name: 'Server' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Server' })).toHaveAttribute('aria-current', 'page');
  const githubCard = page.getByRole('region', { name: 'Sign in with GitHub' });
  await expect(githubCard.getByText(`Client ID ${github.clientId}`)).toBeVisible();
  await expect(githubCard.getByText(`${origin}/auth/callback/github`)).toBeVisible();

  // A wrong secret: GitHub's words, and nothing kept. The right one is kept.
  await githubCard.getByRole('button', { name: 'Replace credentials' }).click();
  await githubCard.getByLabel('Client ID').fill(github.clientId);
  await githubCard.getByLabel('Client secret').fill('wrong-secret');
  await githubCard.getByRole('button', { name: 'Try the connection and save' }).click();
  await expect(
    githubCard.getByText('GitHub knows the app and refused the client secret.'),
  ).toBeVisible();
  await githubCard.getByLabel('Client secret').fill(github.clientSecret);
  await githubCard.getByRole('button', { name: 'Try the connection and save' }).click();
  await expect(
    githubCard.getByText('Saved. GitHub sign-in uses this app from now on.'),
  ).toBeVisible();

  // The policy applies as it is chosen, and the sign-in screens are told at once.
  await page
    .getByRole('region', { name: 'Who can create an account' })
    .getByRole('radio', { name: /Anyone/ })
    .check();
  await expect(page.getByText('Saved. This applies from the next sign-up.')).toBeVisible();
  const methods = await page.request.get('/api/auth/methods');
  expect(await methods.json()).toEqual({
    github: true,
    email: false,
    oidc: null,
    signUp: 'open',
  });

  // Only GitHub is connected: disconnecting it is the last way in, and says so before it asks.
  await githubCard.getByRole('button', { name: 'Disconnect' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/the last way for other people to sign in/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Disconnect anyway' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(githubCard.getByText(`Client ID ${github.clientId}`)).toBeVisible();

  // Accounts (D-233): the administrator is listed, said to administer the server, with no button —
  // nobody suspends the administration; a search that matches nobody says so.
  const accounts = page.getByRole('region', { name: 'Accounts' });
  const adminRow = accounts.getByRole('listitem').filter({ hasText: 'Administers this server' });
  await expect(adminRow).toHaveCount(1);
  await expect(adminRow.getByRole('button')).toHaveCount(0);
  await accounts.getByLabel('Find by name, username or address').fill('nobody-by-this-name');
  await expect(accounts.getByText('No account matches.')).toBeVisible();

  // Anybody else is told the route does not exist.
  const stranger = await browser.newContext({ baseURL: origin });
  const refused = await stranger.request.get('/api/server/settings');
  expect(refused.status()).toBe(404);
  expect((await stranger.request.get('/api/server/accounts')).status()).toBe(404);
  await stranger.close();
  await context.close();
});
