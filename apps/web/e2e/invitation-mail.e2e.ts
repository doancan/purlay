/** Settings → invitations → SMTP letter → a newcomer's verified account and workspace membership. */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { letterWith, linkIn, portFor, startFresh, type FreshServer } from './fresh';
import { skipReleaseNotes } from './support';

let fresh: FreshServer | null = null;

test.beforeAll(async ({}, info) => {
  test.skip(info.project.name !== 'chromium-light', 'one isolated server proves the SMTP path');
  test.setTimeout(240_000);
  fresh = await startFresh(portFor(90));
});

test.afterAll(() => {
  fresh?.stop();
});

test('an owner emails invitations from Settings and a newcomer joins through the letter', async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  if (fresh === null) throw new Error('the invitation test server did not start');
  const { origin, code, github, relay, mailbox } = fresh.manifest;
  const owner = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  await skipReleaseNotes(owner);
  const send = async (path: string, data?: unknown): Promise<void> => {
    const response = await owner.request.post(path, { data, headers: { origin } });
    expect(response.ok(), `${path}: ${String(response.status())} ${await response.text()}`).toBe(
      true,
    );
  };
  try {
    await send('/setup/claim', { code });
    await send('/setup/admin', {
      name: 'Ada Yılmaz',
      email: 'ada@example.test',
      password: 'a long and unusual phrase 7',
    });
    await send('/setup/address', { confirmed: true });
    await send('/setup/policy', { signUp: 'invite-only' });
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
    const verification = linkIn(
      await letterWith(mailbox, /Confirm your address/),
      /\/setup\/verify#[0-9a-f]{64}/,
    );
    await send('/setup/verify', { token: verification.split('#')[1] });
    await send('/setup/workspace', { name: 'Invite Team', slug: 'invite-team' });
    await send('/setup/invite');
    await send('/setup/finish');
    await send('/api/server/preferences', { requireAccountApproval: true });

    const page = await owner.newPage();
    await page.goto('/w/invite-team/settings/invitations');
    const main = page.getByRole('main');
    const field = main.getByRole('textbox', { name: 'Email addresses', exact: true });
    await expect(field).toBeVisible();
    await field.fill('ann@example.test,bob@example.test,nope,');
    await field.press('Enter');
    await main.getByRole('button', { name: 'Send 2 invitations' }).click();
    await expect(
      main.getByText('Asked the mail server to send the invitation to 2 people.'),
    ).toBeVisible();
    await expect(main.getByRole('button', { name: 'Remove nope' })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Remove ann@example.test' })).toHaveCount(0);
    const link = await main.getByRole('textbox', { name: 'Invitation link' }).inputValue();
    const token = link.split('#')[1];
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // These are the actual messages accepted by the loopback SMTP relay, not mocked HTTP outcomes.
    const letters = [
      await letterWith(mailbox, /You have been invited to Purlay/, 0),
      await letterWith(mailbox, /You have been invited to Purlay/, 1),
    ];
    expect(letters.flatMap((letter) => letter.to).sort()).toEqual([
      'ann@example.test',
      'bob@example.test',
    ]);
    for (const letter of letters) {
      expect(letter.text).toContain('Ada Yılmaz');
      expect(letter.text).toContain('Invite Team');
      expect(linkIn(letter, /\/invite#[0-9a-f]{64}/)).not.toBe(`/invite#${token ?? ''}`);
    }

    // A separate management tab keeps filters through reload/Back without disturbing the
    // one-time copy link this original tab still holds.
    const filteredTab = await owner.newPage();
    try {
      await filteredTab.goto('/w/invite-team/settings/invitations');
      const card = filteredTab.getByRole('region', { name: 'Email invitations' });
      await card.getByRole('textbox', { name: 'Search email addresses' }).fill('ANN@EXAMPLE');
      await card.getByRole('combobox', { name: 'Invitation status' }).selectOption('accepted');
      await card.getByRole('button', { name: 'Search recipients' }).click();
      await expect(card.getByRole('listitem')).toHaveCount(1);
      await expect(card.getByRole('listitem')).toContainText('ann@example.test');
      await filteredTab.reload();
      await expect(card.getByRole('textbox', { name: 'Search email addresses' })).toHaveValue(
        'ANN@EXAMPLE',
      );
      await expect(card.getByRole('combobox', { name: 'Invitation status' })).toHaveValue(
        'accepted',
      );
      await card.getByRole('textbox', { name: 'Search email addresses' }).fill('nobody-matches');
      await card.getByRole('textbox', { name: 'Search email addresses' }).press('Enter');
      await expect(card.getByText('No invitations match these filters.')).toBeVisible();
      await expect(card.getByRole('button', { name: 'Resend', exact: true })).toHaveCount(0);
      await filteredTab.goBack();
      await expect(card.getByRole('textbox', { name: 'Search email addresses' })).toHaveValue(
        'ANN@EXAMPLE',
      );
      await expect(card.getByRole('listitem')).toHaveCount(1);
      await card.getByRole('button', { name: 'Clear filters' }).click();
      await expect(card.getByRole('listitem')).toHaveCount(2);
      await expect(filteredTab).toHaveURL(/\/settings\/invitations$/);
    } finally {
      await filteredTab.close();
    }
    await page.bringToFront();
    const emailed = main.getByRole('list', { name: 'Email invitations' });
    const bobRow = emailed.getByRole('listitem').filter({ hasText: 'bob@example.test' });
    await expect(bobRow.getByRole('status')).toHaveText('Accepted by mail server');
    await bobRow.getByRole('button', { name: 'Resend', exact: true }).click();
    const replacement = await letterWith(mailbox, /You have been invited to Purlay/, 2);
    const oldBob = letters.find((letter) => letter.to.includes('bob@example.test'));
    if (oldBob === undefined) throw new Error('Bob’s letter missing');
    const oldBobToken = linkIn(oldBob, /\/invite#[0-9a-f]{64}/).split('#')[1];
    const replacementToken = linkIn(replacement, /\/invite#[0-9a-f]{64}/).split('#')[1];
    expect(replacementToken).not.toBe(oldBobToken);
    expect(
      (
        await owner.request.post('/api/invitations/preview', {
          data: { token: oldBobToken },
          headers: { origin },
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await owner.request.post('/api/invitations/preview', {
          data: { token: replacementToken },
          headers: { origin },
        })
      ).status(),
    ).toBe(200);
    await bobRow.getByRole('button', { name: 'Send history', exact: true }).click();
    await expect(bobRow.getByText('Link revoked', { exact: true })).toBeVisible();
    // Another tab changes the recipient while this tab keeps its history open. Its polling
    // must update both the summary and the loaded history, without toggling the history.
    const otherTab = await owner.newPage();
    try {
      await otherTab.goto('/w/invite-team/settings/invitations');
      await otherTab
        .getByRole('list', { name: 'Email invitations' })
        .getByRole('listitem')
        .filter({ hasText: 'bob@example.test' })
        .getByRole('button', { name: 'Revoke', exact: true })
        .click();
      await expect(otherTab.getByText('Link revoked', { exact: true })).toHaveCount(2);
    } finally {
      await otherTab.close();
    }
    await page.bringToFront();
    await expect(bobRow.getByRole('status')).toHaveText('Link revoked', { timeout: 15_000 });
    // The summary, latest attempt, and both historical links are now revoked.
    await expect(bobRow.getByText('Link revoked', { exact: true })).toHaveCount(4);
    await bobRow.getByRole('button', { name: 'Send history', exact: true }).click();

    // The form and its feedback reflow on a phone and at the 320 CSS px accessibility boundary.
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await expect
        .poll(
          async () => await main.evaluate((element) => element.scrollWidth <= element.clientWidth),
          { message: `invitation form fits ${String(width)} CSS px` },
        )
        .toBe(true);
      await expect(main.getByRole('button', { name: 'Make another link' })).toBeVisible();
      if (width <= 390) {
        expect(
          await field.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
        ).toBeGreaterThanOrEqual(16);
        expect(
          await main
            .getByRole('textbox', { name: 'Invitation link' })
            .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
        ).toBeGreaterThanOrEqual(16);
      }
      const audit = await new AxeBuilder({ page }).include('main').analyze();
      expect(audit.violations).toEqual([]);
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme });
        const auditTheme = await new AxeBuilder({ page }).include('main').analyze();
        expect(auditTheme.violations).toEqual([]);
        const screenshot = info.outputPath(`invitations-${theme}-${String(width)}.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        await info.attach(`invitations-${theme}-${String(width)}`, {
          path: screenshot,
          contentType: 'image/png',
        });
        await emailed.getByRole('listitem').first().scrollIntoViewIfNeeded();
        const recipientsShot = info.outputPath(
          `invitation-recipients-${theme}-${String(width)}.png`,
        );
        await page.screenshot({ path: recipientsShot });
        await info.attach(`invitation-recipients-${theme}-${String(width)}`, {
          path: recipientsShot,
          contentType: 'image/png',
        });
      }
      await page.emulateMedia({ colorScheme: 'light' });
    }

    const newcomer = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
    await skipReleaseNotes(newcomer);
    try {
      const invited = await newcomer.newPage();
      const annLetter = letters.find((letter) => letter.to.includes('ann@example.test'));
      if (annLetter === undefined) throw new Error('Ann’s letter missing');
      await invited.goto(linkIn(annLetter, /\/invite#[0-9a-f]{64}/));
      await expect(invited.getByRole('heading', { name: 'You have been invited' })).toBeVisible();
      expect(invited.url()).not.toContain(token ?? 'missing token');
      await invited.getByRole('textbox', { name: 'Email address' }).fill('ann@example.test');
      await invited.getByRole('button', { name: 'Email me a sign-in link' }).click();
      const signIn = linkIn(
        await letterWith(mailbox, /Your sign-in link/),
        /\/sign-in\/email#[0-9A-Za-z_.-]+/,
      );
      await invited.goto(signIn);
      await invited.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(
        invited.getByRole('heading', { name: 'Your account is awaiting approval' }),
      ).toBeVisible();
      const recipients = page.getByRole('list', { name: 'Email invitations' });
      const annRow = recipients.getByRole('listitem').filter({ hasText: 'ann@example.test' });
      await expect(annRow.getByRole('status')).toHaveText('Awaiting account approval');
      const approval = await owner.newPage();
      await approval.goto('/server/users');
      await approval.getByRole('combobox', { name: 'Status', exact: true }).selectOption('pending');
      await approval.getByRole('button', { name: 'Search', exact: true }).click();
      await approval.getByRole('button', { name: 'Approve account' }).click();
      await approval.getByRole('dialog').getByRole('button', { name: 'Confirm change' }).click();
      await expect(approval.getByText('Change saved')).toBeVisible();
      await approval.close();
      // The pending page continues to the same invitation without Refresh or a reload.
      await expect(invited.getByRole('heading', { name: 'Join Invite Team' })).toBeVisible({
        timeout: 15_000,
      });
      await invited.getByRole('button', { name: 'Join', exact: true }).click();
      await expect(invited).toHaveURL(/\/w\/invite-team\/welcome$/);
      await page.reload();
      await expect(
        page
          .getByRole('list', { name: 'Email invitations' })
          .getByRole('listitem')
          .filter({ hasText: 'ann@example.test' })
          .getByRole('status'),
      ).toHaveText('Invitation accepted');
      const me = await newcomer.request.get('/api/me');
      expect(await me.json()).toMatchObject({
        user: { email: 'ann@example.test' },
        memberships: [{ role: 'member', workspace: { slug: 'invite-team' } }],
      });
    } finally {
      await newcomer.close();
    }

    // The same page can issue a separate link, and revoking it removes the one-time copy field.
    await page.setViewportSize({ width: 1440, height: 900 });
    await main.getByRole('button', { name: 'Make a link', exact: true }).click();
    await expect(main.getByRole('textbox', { name: 'Invitation link' })).not.toHaveValue(link);
    await main
      .getByRole('region', { name: 'Links still open' })
      .getByRole('button', { name: 'Revoke', exact: true })
      .first()
      .click();
    await expect(main.getByRole('textbox', { name: 'Invitation link' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Make a link' })).toBeVisible();
  } finally {
    await owner.close();
  }
});
