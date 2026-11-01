/**
 * GitHub issues from conversations, connected (D-246 §1–2), through the screens, against a real server and a
 * GitHub that is as strict as the real one (`testing/github-app-stub.ts`): the server's administrator connects
 * the App — a key from another App refused in words and nothing kept — an owner installs it on GitHub's own
 * screen and comes back connected, a person lets Purlay write as them and stops it, and the same page says it
 * all in Turkish. Nothing of it is drawn on a server without an App, and no secret is on any page.
 *
 * Its own server, scratch database and GitHub stand-in (`fresh.ts`); run narrow and light, since the other
 * specs of the wizard hold the wide and the dark.
 */
import { generateKeyPairSync } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { portFor, startFresh, type FreshServer } from './fresh';

const PORT = portFor(120);
/** What a key is written as: GitHub's PEM. */
const PEM = 'pem';

let fresh: FreshServer | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, info) => {
  test.skip(info.project.name !== 'chromium-light-narrow', 'one run proves the path');
  test.setTimeout(240_000);
  fresh = await startFresh(PORT);
});

test.afterAll(() => {
  fresh?.stop();
});

test('the administrator connects the App, an owner installs it, a person allows writing as themselves', async ({
  browser,
}) => {
  if (fresh === null) throw new Error('the server did not start');
  const { origin, code, github, githubApp } = fresh.manifest;
  const context = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });

  // The setup, finished through the API: the administrator is the first workspace's owner.
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
  await send('/setup/policy', { signUp: 'open' });
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

  // No App yet: nothing of issues is drawn anywhere.
  await page.goto('/w/acme-engineering/settings/integrations');
  await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'GitHub issues' })).toHaveCount(0);
  await page.goto('/w/acme-engineering/settings/account');
  await expect(page.getByRole('heading', { level: 1, name: 'Sessions & account' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Create issues as you' })).toHaveCount(0);

  // The administrator connects the App: a key from another App is refused in words, nothing kept.
  await page.goto('/w/acme-engineering/settings/server');
  const card = page.getByRole('region', { name: 'GitHub App for issues' });
  await expect(card.getByText('Not connected')).toBeVisible();
  await expect(card.getByText(`${origin}/api/github-app/callback`)).toBeVisible();
  await expect(card.getByText(`${origin}/api/webhooks/github-app`)).toBeVisible();
  await card.getByRole('button', { name: 'Connect the GitHub App' }).click();
  await card.getByLabel('App ID').fill(String(githubApp.appId));
  await card.getByLabel('App slug').fill(githubApp.slug);
  await card.getByLabel('Client ID').fill(githubApp.clientId);
  await card.getByLabel('Client secret').fill(githubApp.clientSecret);
  await card.getByLabel('Webhook secret').fill(githubApp.webhookSecret);
  const anotherKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: PEM },
    publicKeyEncoding: { type: 'spki', format: PEM },
  }).privateKey;
  await card.getByLabel('Private key').fill(anotherKey);
  await card.getByRole('button', { name: 'Try the connection and save' }).click();
  await expect(card.getByText('GitHub refused what this private key signed.')).toBeVisible();
  expect(await (await page.request.get('/api/server/settings')).json()).toMatchObject({
    settings: { githubApp: null },
  });

  // The right one is kept, and no secret is anywhere on the page.
  await card.getByLabel('Private key').fill(githubApp.privateKey);
  await card.getByRole('button', { name: 'Try the connection and save' }).click();
  await expect(card.getByText('Saved. Workspaces can connect an installation now.')).toBeVisible();
  await expect(card.getByText(`${githubApp.slug} · App ${String(githubApp.appId)}`)).toBeVisible();
  const content = await page.content();
  for (const secret of [githubApp.clientSecret, githubApp.webhookSecret, 'PRIVATE KEY']) {
    expect(content).not.toContain(secret);
  }

  // The owner installs it: GitHub's own screen, and back to Integrations, connected.
  await page.goto('/w/acme-engineering/settings/integrations');
  const installation = page.getByRole('region', { name: 'GitHub issues' });
  await expect(installation.getByText('No installation is connected yet.')).toBeVisible();
  await installation.getByRole('button', { name: 'Connect on GitHub' }).click();
  await page.waitForURL(/\/settings\/integrations\?github=connected$/);
  await expect(installation.getByText('The installation is connected.')).toBeVisible();
  await expect(installation.getByText(/Installed on acme since/)).toBeVisible();
  // Connecting kept no token of the owner's: writing as oneself is a choice of its own.
  await page.goto('/w/acme-engineering/settings/account');
  const mine = page.getByRole('region', { name: 'Create issues as you' });
  await expect(
    mine.getByText('Not allowed. Purlay writes nothing to GitHub as you.'),
  ).toBeVisible();

  // The person chooses: GitHub's authorization screen, and back to this page.
  await mine.getByRole('button', { name: 'Let Purlay create issues as me' }).click();
  await page.waitForURL(/\/settings\/account\?github=authorized$/);
  await expect(mine.getByText('Allowed, as ayse.')).toBeVisible();
  await expect(mine.getByText('Purlay may create issues as you.')).toBeVisible();

  // The same page, in Turkish, for somebody whose browser is.
  const turkish = await browser.newContext({
    baseURL: origin,
    reducedMotion: 'reduce',
    locale: 'tr-TR',
    storageState: await context.storageState(),
  });
  const tr = await turkish.newPage();
  await tr.goto('/w/acme-engineering/settings/account');
  const benim = tr.getByRole('region', { name: 'Senin adına issue aç' });
  await expect(benim.getByText('İzin verildi: ayse.')).toBeVisible();
  await benim.getByRole('button', { name: 'İzni kaldır' }).click();
  await expect(
    benim.getByText('İzin verilmedi. Purlay GitHub’a senin adına hiçbir şey yazmaz.'),
  ).toBeVisible();
  await turkish.close();

  // Stopped in Turkish, it is stopped here: the choice is the person's, not the page's language.
  await page.reload();
  await expect(
    mine.getByText('Not allowed. Purlay writes nothing to GitHub as you.'),
  ).toBeVisible();
  await context.close();
});
