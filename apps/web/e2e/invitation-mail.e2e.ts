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

    const page = await owner.newPage();
    await page.goto('/w/invite-team/settings/invitations');
    const main = page.getByRole('main');
    const field = main.getByRole('textbox', { name: 'Email addresses' });
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
      expect(linkIn(letter, /\/invite#[0-9a-f]{64}/)).toBe(`/invite#${token ?? ''}`);
    }

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
      const screenshot = info.outputPath(`invitations-${String(width)}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await info.attach(`invitations-${String(width)}`, {
        path: screenshot,
        contentType: 'image/png',
      });
    }

    const newcomer = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
    await skipReleaseNotes(newcomer);
    try {
      const invited = await newcomer.newPage();
      await invited.goto(link);
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
      await expect(invited.getByRole('heading', { name: 'Join Invite Team' })).toBeVisible();
      await invited.getByRole('button', { name: 'Join', exact: true }).click();
      await expect(invited).toHaveURL(/\/w\/invite-team\/welcome$/);
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
    await main.getByRole('button', { name: 'Make another link' }).click();
    await expect(main.getByRole('textbox', { name: 'Invitation link' })).not.toHaveValue(link);
    await main.getByRole('button', { name: 'Revoke', exact: true }).first().click();
    await expect(main.getByRole('textbox', { name: 'Invitation link' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Make a link' })).toBeVisible();
  } finally {
    await owner.close();
  }
});
