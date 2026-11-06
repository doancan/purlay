/** The standalone console, saved SMTP, account approval and quota changes against an isolated server. */
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { ServerUserPage } from '@purlay/types';
import { letterWith, linkIn, portFor, startFresh, type FreshServer } from './fresh';
import { skipReleaseNotes } from './support';
let fresh: FreshServer | null = null;
test.beforeAll(async ({}, info) => {
  test.skip(
    info.project.name !== 'chromium-light',
    'one isolated server; both themes checked below',
  );
  test.setTimeout(240_000);
  fresh = await startFresh(portFor(180));
});
test.afterAll(() => {
  fresh?.stop();
});

test('administration is independent, responsive, keyboard accessible and backed by real account, mail and quota operations', async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  if (fresh === null) throw new Error('the administration server did not start');
  const { origin, code, github, relay, mailbox } = fresh.manifest;
  const owner = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  const applicant = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  const secondApplicant = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  owner.setDefaultTimeout(10_000);
  applicant.setDefaultTimeout(10_000);
  await skipReleaseNotes(owner);
  await skipReleaseNotes(applicant);
  await skipReleaseNotes(secondApplicant);
  const send = async (path: string, data?: unknown): Promise<void> => {
    const response = await owner.request.post(path, { data, headers: { origin } });
    expect(response.ok(), `${path}: ${String(response.status())} ${await response.text()}`).toBe(
      true,
    );
  };
  {
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
    const verify = linkIn(
      await letterWith(mailbox, /Confirm your address/),
      /\/setup\/verify#[0-9a-f]{64}/,
    );
    await send('/setup/verify', { token: verify.split('#')[1] });
    await send('/setup/workspace', { name: 'Console team', slug: 'console-team' });
    await send('/setup/invite');
    await send('/setup/finish');
    const page = await owner.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/server/email');
    const mail = page.getByRole('region', { name: 'Test saved mail configuration' });
    await mail.getByRole('button', { name: 'Send test email' }).click();
    await expect(
      mail.getByText('The relay accepted this test message. Check your inbox and spam folder.'),
    ).toBeVisible();
    expect((await letterWith(mailbox, /A test from your Purlay server/)).to).toEqual([
      'operator@example.test',
    ]);
    await page.reload();
    await expect(
      mail.getByText('The relay accepted this test message. Check your inbox and spam folder.'),
    ).toBeVisible();
    await page.goto('/server/overview');
    const identity = page.getByRole('region', { name: 'Server identity' });
    await identity.getByLabel('Server display name').fill('Research server');
    await identity.getByLabel('Support address').fill('mailto:help@example.test');
    await identity.getByRole('button', { name: 'Save settings' }).click();
    await expect(identity.getByText('Change saved')).toBeVisible();
    await page.goto('/server/security');
    const policy = page.getByRole('region', { name: 'New account admission' });
    await policy.getByLabel('Allowed email domains').fill('example.test');
    await policy.getByRole('checkbox').check();
    await policy.getByRole('button', { name: 'Save settings' }).click();
    await expect(policy.getByText('Change saved')).toBeVisible();
    const requested = await applicant.request.post('/auth/email', {
      data: { email: 'applicant@example.test', locale: 'en' },
      headers: { origin },
    });
    expect(requested.status()).toBe(202);
    const letter = await letterWith(mailbox, /sign.in/i);
    const token = /#([0-9a-f]{64})/.exec(letter.text)?.[1];
    expect(token).toBeDefined();
    const consumed = await applicant.request.post('/auth/email/consume', {
      data: { token },
      headers: { origin },
    });
    expect(consumed.status()).toBe(204);
    const pending = await applicant.newPage();
    await pending.goto('/');
    await expect(
      pending.getByRole('heading', { name: 'Your account is awaiting approval' }),
    ).toBeVisible();
    await expect(pending.getByText('Research server')).toBeVisible();
    await expect(pending.getByRole('link', { name: 'Contact support' })).toHaveAttribute(
      'href',
      'mailto:help@example.test',
    );
    expect((await applicant.request.get('/api/workspaces')).status()).toBe(401);
    expect(
      (
        await secondApplicant.request.post('/auth/email', {
          data: { email: 'applicant-two@example.test', locale: 'en' },
          headers: { origin },
        })
      ).status(),
    ).toBe(202);
    const secondLetter = await letterWith(mailbox, /sign.in/i, 1);
    const secondToken = /#([0-9a-f]{64})/.exec(secondLetter.text)?.[1];
    expect(secondToken).toBeDefined();
    expect(
      (
        await secondApplicant.request.post('/auth/email/consume', {
          data: { token: secondToken },
          headers: { origin },
        })
      ).status(),
    ).toBe(204);
    const secondPending = await secondApplicant.newPage();
    await secondPending.goto('/');
    await expect(
      secondPending.getByRole('heading', { name: 'Your account is awaiting approval' }),
    ).toBeVisible();
    await page.goto('/server/users');
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('pending');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('button', { name: 'Select pending accounts on this page' }).click();
    await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.setAttribute('data-theme', value);
      }, theme);
      for (const width of [1360, 768, 320]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.getByRole('button', { name: 'Approve selected accounts', exact: true }).focus();
        await page.keyboard.press('Enter');
        const review = page.getByRole('dialog', { name: 'Approve selected accounts' });
        await expect(review.getByText('applicant-two@example.test', { exact: true })).toBeVisible();
        expect(
          (
            await new AxeBuilder({ page })
              .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
              .analyze()
          ).violations,
        ).toEqual([]);
        if (width === 320)
          await page.screenshot({
            path: info.outputPath(`batch-approval-${theme}-320.png`),
            fullPage: true,
          });
        await page.keyboard.press('Escape');
        await expect(review).toHaveCount(0);
        await expect(
          page.getByRole('button', { name: 'Approve selected accounts', exact: true }),
        ).toBeFocused();
      }
    }
    await page.getByRole('button', { name: 'Approve selected accounts', exact: true }).click();
    const approvals = page.getByRole('dialog', { name: 'Approve selected accounts' });
    await expect(approvals.getByText('applicant@example.test', { exact: true })).toBeVisible();
    await expect(approvals.getByText('applicant-two@example.test', { exact: true })).toBeVisible();
    await approvals.getByRole('button', { name: 'Confirm approvals' }).click();
    await expect(
      page
        .getByRole('region', { name: 'Approval results' })
        .getByText('Approved: 2/2', { exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath('batch-approval-results-320.png'),
      fullPage: true,
    });
    await expect(
      pending.getByRole('heading', { name: 'Your account is awaiting approval' }),
    ).toHaveCount(0);
    expect((await applicant.request.get('/api/me')).status()).toBe(200);
    await expect(
      secondPending.getByRole('heading', { name: 'Your account is awaiting approval' }),
    ).toHaveCount(0);
    expect((await secondApplicant.request.get('/api/me')).status()).toBe(200);
    const users = (await (
      await owner.request.get('/api/server/users?status=active')
    ).json()) as ServerUserPage;
    expect(users.data.some((user) => user.email === 'applicant@example.test')).toBe(true);
    expect(users.data.some((user) => user.email === 'applicant-two@example.test')).toBe(true);
    await page.goto('/server/workspaces');
    await page.getByRole('button', { name: 'Change quota' }).click();
    await page.getByRole('dialog').getByLabel('Quota in bytes').fill('1024');
    await page.getByRole('dialog').getByLabel('Quota in bytes').press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page.getByRole('region', { name: 'Console team' }).locator('[title="1024 B"]'),
    ).toBeVisible();
    for (const dark of [false, true]) {
      await page.evaluate(
        (theme) => {
          localStorage.setItem('purlay.theme', theme);
        },
        dark ? 'dark' : 'light',
      );
      for (const width of [1360, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const section of [
          'overview',
          'users',
          'workspaces',
          'security',
          'email',
          'data',
          'integrations',
          'operations',
          'audit',
        ]) {
          await page.goto(`/server/${section}`);
          await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
          await expect(page.getByRole('region').first()).toBeVisible();
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          if (width === 320) {
            expect(
              await page
                .locator(
                  'main input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]),main select,main textarea',
                )
                .evaluateAll(
                  (elements) =>
                    elements.filter(
                      (element) =>
                        element.getBoundingClientRect().width > 0 &&
                        parseFloat(getComputedStyle(element).fontSize) < 16,
                    ).length,
                ),
            ).toBe(0);
          }
        }
      }
    }
    await page.getByRole('button', { name: 'Sections' }).focus();
    await page.keyboard.press('Enter');
    const nav = page.getByRole('navigation', { name: 'Administration sections' });
    await expect(nav).toBeVisible();
    await nav.getByRole('link', { name: 'Users and administrators' }).focus();
    await page.keyboard.press('Enter');
    await expect(nav).toBeHidden();
    await expect(page.getByRole('main')).toBeFocused();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({ path: info.outputPath('administration-320.png'), fullPage: true });
    await page.goto('/server/audit');
    await page
      .getByRole('combobox', { name: 'Action', exact: true })
      .selectOption('server.account_approved');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(
      page.getByRole('listitem').getByText('Account approved', { exact: true }),
    ).toHaveCount(2);
    const personChoice = page.getByRole('button', { name: 'Person: Anyone', exact: true });
    await personChoice.click();
    const chooser = page.getByRole('dialog', { name: 'Choose a person' });
    await chooser
      .getByRole('textbox', { name: 'Search by name, username or email' })
      .fill('operator');
    await chooser.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(
      chooser.getByRole('button', { name: 'Select Operator · operator@example.test' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(chooser).toHaveCount(0);
    await expect(personChoice).toBeFocused();
    await personChoice.click();
    await chooser.getByRole('button', { name: 'Select Operator · operator@example.test' }).click();
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    for (const [name, format] of [
      ['Download CSV', 'csv'],
      ['Download NDJSON', 'ndjson'],
    ] as const) {
      const result = page.waitForEvent('download');
      await page.getByRole('link', { name, exact: true }).click();
      const download = await result;
      expect(download.suggestedFilename()).toMatch(new RegExp(`^server-audit-.*\\.${format}$`));
      const output = info.outputPath(`server-audit.${format}`);
      await download.saveAs(output);
      const text = await readFile(output, 'utf8');
      expect(text).toContain('server.account_approved');
      expect(text).toContain('Operator');
      expect(text.trim().split('\n')).toHaveLength(format === 'csv' ? 3 : 2);
      expect(text).not.toContain('server.smtp_connected');
      expect(text).not.toContain('smtp://');
    }
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: info.outputPath('server-audit-filtered-320.png'),
      fullPage: true,
    });
    await page.evaluate(() => {
      localStorage.setItem('purlay.locale', 'tr');
    });
    await page.reload();
    await expect(
      page.getByRole('listitem').getByText('Hesap onaylandı', { exact: true }),
    ).toHaveCount(2);
    await expect(page.getByRole('link', { name: 'CSV indir', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  }
  await applicant.close();
  await secondApplicant.close();
  await owner.close();
});
