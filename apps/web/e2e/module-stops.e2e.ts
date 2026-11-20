/**
 * Administration → Modules against a server of its own (D-296, D-323): the administrator stops a module with a reason, the module's
 * route answers as one the server does not run, the trail keeps the reason, and letting it run again brings it back; a stop of chat
 * asks to be meant, a cluster not ready for it is said plainly, and somebody who is not the administrator reaches none of it.
 *
 * A server of its own because a stop is for every workspace: in the suite's shared world it would stop issues under other specs.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { MeResponse, ServerAuditPage } from '@purlay/types';
import { letterWith, portFor, startFresh, type FreshServer } from './fresh';
import { skipReleaseNotes } from './support';

let fresh: FreshServer | null = null;
test.beforeAll(async ({}, info) => {
  test.skip(info.project.name !== 'chromium-light', 'one server of its own; a stop is server-wide');
  test.setTimeout(240_000);
  fresh = await startFresh(portFor(140));
});
test.afterAll(() => {
  fresh?.stop();
});

/** A refusal as the server words it, without the request id that differs between two answers. */
const refusalOf = async (
  request: APIRequestContext,
  path: string,
): Promise<{ status: number; code: unknown; message: unknown }> => {
  const response = await request.get(path);
  const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
  return { status: response.status(), code: body.error?.code, message: body.error?.message };
};

test('an administrator stops a module with a reason, its route answers as unknown, and it runs again', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  if (fresh === null) throw new Error('the server did not start');
  const { origin, code, github, relay, mailbox } = fresh.manifest;
  const owner = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  const member = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  await skipReleaseNotes(owner);
  await skipReleaseNotes(member);
  const send = async (path: string, data?: unknown): Promise<void> => {
    const response = await owner.request.post(path, { data, headers: { origin } });
    expect(response.ok(), `${path}: ${String(response.status())} ${await response.text()}`).toBe(
      true,
    );
  };
  await send('/setup/claim', { code });
  await send('/setup/admin', {
    name: 'Operator',
    email: 'operator@example.test',
    password: 'Purlay-review-password-2026!',
  });
  await send('/setup/address', { confirmed: true });
  await send('/setup/policy', { signUp: 'open' });
  await send('/setup/github', {
    clientId: github.clientId,
    clientSecret: github.clientSecret,
    save: true,
  });
  await send('/setup/smtp', {
    smtpUrl: `smtp://127.0.0.1:${String(relay.port)}`,
    from: 'no-reply@example.test',
    allowPlaintext: true,
    locale: 'en',
    save: true,
  });
  const verify = /#([0-9a-f]{64})/.exec((await letterWith(mailbox, /Confirm your address/)).text);
  await send('/setup/verify', { token: verify?.[1] });
  await send('/setup/workspace', { name: 'Module team', slug: 'module-team' });
  await send('/setup/invite');
  await send('/setup/finish');
  const me = (await (await owner.request.get('/api/me')).json()) as MeResponse;
  const workspaceId = me.memberships[0]?.workspace.id ?? '';
  expect(workspaceId).not.toBe('');
  const issuesPath = `/api/workspaces/${workspaceId}/issues`;
  const unknownPath = `/api/workspaces/${workspaceId}/no-such-thing`;
  expect((await owner.request.get(issuesPath)).status()).toBe(200);
  const modulesOf = async (): Promise<readonly string[]> =>
    ((await (await owner.request.get('/api/me')).json()) as MeResponse).modules;
  expect(await modulesOf()).toContain('issues');

  const page = await owner.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/server/overview');
  await page
    .getByRole('navigation', { name: 'Administration sections' })
    .getByRole('link', { name: 'Modules' })
    .click();
  await expect(page).toHaveURL(`${origin}/server/modules`);
  const issues = page.getByRole('region', { name: 'issues', exact: true });
  const chat = page.getByRole('region', { name: 'chat', exact: true });
  await expect(issues.getByText('Running', { exact: true })).toBeVisible();
  await expect(chat.getByText('Running', { exact: true })).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .include('main')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);

  // Chat is the product: its stop asks to be meant, and a cluster that is not ready refuses it in words.
  await chat.getByRole('button', { name: 'Stop…' }).click();
  let dialog = page.getByRole('dialog', { name: 'Stop chat' });
  await dialog.getByLabel('Reason').fill('incident drill');
  await expect(dialog.getByRole('button', { name: 'Stop module' })).toBeDisabled();
  await dialog
    .getByRole('checkbox', {
      name: 'Stopping chat takes the product down for every workspace. I mean it.',
    })
    .check();
  // One node and no Redis here, so the cluster's refusal is the route's answer, given by hand.
  await page.route('**/api/server/modules/chat/suspension', async (route) => {
    await route.fulfill({
      status: 409,
      json: {
        error: {
          code: 'PEERS_BEHIND',
          message: '1 node(s) of this cluster do not read the stopped modules yet.',
        },
      },
    });
  });
  await dialog.getByRole('button', { name: 'Stop module' }).click();
  await expect(
    dialog.getByText(
      'A node of this cluster does not read stopped modules yet, so it would go on serving chat. Finish the rollout, then stop it.',
    ),
  ).toBeVisible();
  await page.unroute('**/api/server/modules/chat/suspension');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await modulesOf()).toContain('chat');

  // Issues: a reason is needed, and then it stops.
  await issues.getByRole('button', { name: 'Stop…' }).click();
  dialog = page.getByRole('dialog', { name: 'Stop issues' });
  await dialog.getByRole('button', { name: 'Stop module' }).click();
  await expect(dialog.getByText('Say why you are stopping it.')).toBeVisible();
  const reason = 'Kayıtlar arası sızıntı — öğrenci <b>notları</b>';
  await dialog.getByLabel('Reason').fill(reason);
  await dialog.getByLabel('Reason').press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText('issues is stopped. Every node stops serving it within two seconds.'),
  ).toBeVisible();
  await expect(issues.getByText('Stopped for every workspace')).toBeVisible();
  await expect(issues.getByText(reason, { exact: true })).toBeVisible();

  // The effect, from the other side: the route answers as a path nothing serves, and the session no longer names it.
  const unknown = await refusalOf(owner.request, unknownPath);
  expect(unknown).toMatchObject({ status: 404, code: 'ROUTE_NOT_FOUND' });
  await expect.poll(async () => await refusalOf(owner.request, issuesPath)).toEqual(unknown);
  expect(await modulesOf()).not.toContain('issues');
  const trail = (await (
    await owner.request.get('/api/server/audit?action=server.module_suspended')
  ).json()) as ServerAuditPage;
  expect(trail.data.map((entry) => [entry.targetModule, entry.note])).toEqual([['issues', reason]]);

  // Somebody who is not the administrator reaches neither the screen nor the route.
  const requested = await member.request.post('/auth/email', {
    data: { email: 'member@example.test', locale: 'en' },
    headers: { origin },
  });
  expect(requested.status()).toBe(202);
  const token = /#([0-9a-f]{64})/.exec((await letterWith(mailbox, /sign.in/i)).text)?.[1];
  const consumed = await member.request.post('/auth/email/consume', {
    data: { token },
    headers: { origin },
  });
  expect(consumed.status()).toBe(204);
  expect((await member.request.get('/api/me')).status()).toBe(200);
  const memberPage = await member.newPage();
  await memberPage.goto('/server/modules');
  await expect(memberPage.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
  await expect(memberPage.getByRole('button', { name: 'Let it run again' })).toHaveCount(0);
  const refused = await member.request.post('/api/server/modules/issues/suspension', {
    data: { state: 'running' },
    headers: { origin },
  });
  expect(refused.status()).toBe(404);
  expect(await modulesOf()).not.toContain('issues');

  // Let it run again: the route is back, and the session names it.
  await issues.getByRole('button', { name: 'Let it run again' }).click();
  await expect(page.getByText('issues is running again.')).toBeVisible();
  await expect(issues.getByText('Running', { exact: true })).toBeVisible();
  await expect.poll(async () => (await owner.request.get(issuesPath)).status()).toBe(200);
  expect(await modulesOf()).toContain('issues');

  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await member.close();
  await owner.close();
});
