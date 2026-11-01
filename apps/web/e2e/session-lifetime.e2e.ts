/**
 * How long a session lasts, through the screens, against a real server (D-244, `UX.md` §11): the setup's
 * administrator chooses an idle timeout on Settings → Server, and the page says it is saved. Then the session's own
 * row is moved two hours into the past, as two hours unused would have left it — the clock is not touched — and the
 * next thing the administrator does lands on the sign-in screen: the server answered as to somebody signed out, and
 * the session is gone. Signing in again with the password is a new session, and the workspace is there.
 *
 * Its own server and scratch database (`fresh.ts`); run once, light and wide.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { portFor, startFresh, type FreshServer } from './fresh';

const PORT = portFor(160);
const EMAIL = 'elif@example.test';
const PASSWORD = 'a long and unusual phrase 9';

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

/**
 * Runs one statement on this spec's own scratch database, as the fresh server names it (`fresh-server.ts`), through
 * Bun's own client: the browser suite holds no database connection of its own.
 */
const onTheServersDatabase = (statement: string): void => {
  const url = new URL(
    process.env['DATABASE_URL'] ?? 'postgres://purlay:purlay@localhost:5432/postgres',
  );
  url.pathname = `/purlay_e2e_fresh_${String(PORT)}`;
  execFileSync(
    'bun',
    ['--no-env-file', '-e', `await Bun.sql.unsafe(${JSON.stringify(statement)});`],
    {
      cwd: join(import.meta.dirname, '../../..'),
      env: { ...process.env, DATABASE_URL: url.toString() },
    },
  );
};

test('an idle timeout chosen on the page signs out a session left unused, at its next action', async ({
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
  await send('/setup/admin', { name: 'Elif Şahin', email: EMAIL, password: PASSWORD });
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
  const lifetime = page.getByRole('region', { name: 'How long a session lasts' });
  const idle = lifetime.getByRole('combobox', { name: 'Sign out when unused for' });
  await expect(idle).toHaveValue('off');
  await idle.selectOption({ label: '1 hour' });
  await expect(lifetime.getByText('Saved. It applies from the next request.')).toBeVisible();
  // Used a moment ago: the session goes on.
  expect((await page.request.get('/api/me')).status()).toBe(200);

  // Two hours pass unused: the session's own row says so, as they would have left it.
  onTheServersDatabase(`UPDATE sessions SET last_used_at = now() - interval '2 hours'`);

  // The next action: the sign-in screen, and the server answers as to somebody signed out.
  await page.getByRole('link', { name: 'Sessions & account' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  expect((await page.request.get('/api/me')).status()).toBe(401);

  // Signing in again is a new session, judged from now.
  await page.goto('/sign-in');
  await page.getByRole('textbox', { name: 'Email address' }).fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Purlay' })).toHaveCount(0);
  await page.goto('/w/acme-engineering/settings/server');
  await expect(
    page
      .getByRole('region', { name: 'How long a session lasts' })
      .getByRole('combobox', { name: 'Sign out when unused for' }),
  ).toHaveValue('1');
  expect((await page.request.get('/api/me')).status()).toBe(200);
  await context.close();
});
