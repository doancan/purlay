/** Company setup, native OAuth and workspace containment through the real browser, API and SQL. */
import { expect, test } from '@playwright/test';
import { portFor } from './fresh';
import { skipReleaseNotes } from './support';
import { startCompanyServer, type CompanyServer } from './company-server';

let server: CompanyServer | undefined;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({}, info) => {
  test.skip(info.project.name !== 'chromium-light-narrow', 'one real native OAuth journey');
  test.setTimeout(240_000);
  server = await startCompanyServer(portFor(86));
});
test.afterAll(async () => {
  test.setTimeout(90_000);
  await server?.stop();
});

test('an owner verifies DNS, tests and enables a provider, links an identity and signs in to its workspace', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  if (server === undefined) throw new Error('Company server is unavailable');
  const world = server.manifest;
  const context = await browser.newContext({
    baseURL: world.origin,
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  try {
    await skipReleaseNotes(context);
    await context.addCookies([
      {
        ...world.cookie,
        domain: new URL(world.origin).hostname,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
    // Only the external provider is routed. Every Purlay page, API and callback is the real server.
    await context.route(`${world.oidc.issuer}/**`, async (route) => {
      const response = await context.request.get(`${world.external}/authorize`, {
        params: { url: route.request().url() },
        headers: { authorization: `Bearer ${world.capability}` },
        maxRedirects: 0,
      });
      await route.fulfill({ response });
    });
    const page = await context.newPage();
    const companyPath = `/w/${world.slug}/settings/company`;
    await page.goto(companyPath);
    await expect(page.getByRole('heading', { name: 'Company sign-in', exact: true })).toBeVisible();
    const domain = page.getByRole('region', { name: 'Verified domains' });
    await domain.getByLabel('Domain', { exact: true }).fill('company.example');
    await domain.getByRole('button', { name: 'Add domain', exact: true }).click();
    await expect(domain.getByText('Waiting for DNS proof', { exact: true })).toBeVisible();
    const proof = await domain.locator('code').allTextContents();
    expect(proof).toHaveLength(2);
    const publish = await context.request.post(`${world.external}/dns`, {
      headers: { authorization: `Bearer ${world.capability}` },
      data: { name: proof[0], value: proof[1] },
    });
    expect(publish.status()).toBe(204);
    await domain.getByRole('button', { name: 'Check DNS', exact: true }).click();
    await expect(domain.getByText('Verified', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Add provider', exact: true }).click();
    await page.getByLabel('Provider name').fill('Company browser SSO');
    await page.getByLabel('Issuer URL').fill(world.oidc.issuer);
    await page.getByLabel('Client ID', { exact: true }).fill(world.oidc.clientId);
    await page.getByLabel('Client secret', { exact: true }).fill(world.oidc.clientSecret);
    await page.getByRole('button', { name: 'Save connection', exact: true }).click();
    const providers = page.getByRole('region', { name: 'Identity providers' });
    await expect(providers.getByText('Sign-in test required', { exact: true })).toBeVisible();
    await expect(
      providers.getByRole('button', { name: 'Enable sign-in', exact: true }),
    ).toBeDisabled();
    expect(await page.content()).not.toContain(world.oidc.clientSecret);
    await providers.getByRole('button', { name: 'Test sign-in', exact: true }).click();
    await expect(providers.getByText('Test passed; sign-in is off', { exact: true })).toBeVisible();
    await providers.getByRole('button', { name: 'Enable sign-in', exact: true }).click();
    await expect(providers.getByText('Sign-in enabled', { exact: true })).toBeVisible();

    await page.goto(`/w/${world.slug}/settings/account`);
    await expect(page.getByRole('region', { name: 'How you sign in', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Link identity', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Unlink identity', exact: true })).toBeVisible();
    const independent = await context.request.get('/api/workspaces');
    expect(independent.status()).toBe(200);
    expect(JSON.stringify(await independent.json())).toContain(world.elsewhereId);

    await context.clearCookies();
    await page.goto(`/sign-in?workspace=${world.slug}`);
    await page.getByRole('button', { name: 'Find company sign-in', exact: true }).click();
    await page
      .getByRole('button', { name: 'Continue with Company browser SSO', exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/w/${world.slug}(?:/|$)`));
    const me = await context.request.get('/api/me');
    expect(me.status()).toBe(200);
    expect(await me.json()).toMatchObject({
      user: { id: world.userId },
      companyWorkspaceId: world.workspaceId,
    });
    const scoped = await context.request.get('/api/workspaces');
    expect(scoped.status()).toBe(200);
    const scopedBody = JSON.stringify(await scoped.json());
    expect(scopedBody).toContain(world.workspaceId);
    expect(scopedBody).not.toContain(world.elsewhereId);
    expect((await context.request.get(`/api/workspaces/${world.elsewhereId}`)).status()).toBe(404);
    await page.goto(`/w/${world.slug}/settings/account`);
    await expect(
      page.getByText('Signed in with a company identity', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Link identity', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'How you sign in', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Change password', exact: true })).toHaveCount(0);
    await page.goto(`/w/${world.slug}/settings/profile`);
    await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
    await expect(
      page.getByText('Signed in with a company identity', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('main').getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    const observations = await context.request.get(`${world.external}/observations`, {
      headers: { authorization: `Bearer ${world.capability}` },
    });
    const observed = (await observations.json()) as { urls: string[]; refusals: string[] };
    expect(observed.urls.filter((url) => url.endsWith('/token'))).toHaveLength(3);
    expect(observed.refusals).toEqual([]);
  } finally {
    await context.close();
  }
});
