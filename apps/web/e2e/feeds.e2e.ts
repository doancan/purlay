/**
 * A repository connected to a channel, the whole way (#79, D-134): the workspace's owner opens the
 * channel's details in a real browser, connects a repository through the API, is shown the address,
 * the content type and the secret once, the channel lists it, and its code references link into it
 * (D-223) — clean of contrast and role violations in both themes and at both widths.
 */
import { createHmac } from 'node:crypto';
import { expect, test } from './fixtures';

const sha = (c: string): string => c.repeat(40);

/** A push to `acme/feeds`, as GitHub sends one, as far as the feed reads it; each `tip` is its own body. */
const push = (tip: string): string =>
  JSON.stringify({
    repository: { id: 4242, full_name: 'acme/feeds' },
    sender: { login: 'octocat' },
    ref: 'refs/heads/main',
    before: sha('a'),
    after: sha(tip),
    created: false,
    deleted: false,
    forced: false,
    commits: [{ id: sha(tip), message: 'Retry with jitter' }],
  });

const signedBy = (secret: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

test.describe('a channel’s repositories', () => {
  test('connected by the owner: what GitHub needs is shown once, and the feed is listed', async ({
    page,
    signIn,
    room,
    expectNoAxe,
  }) => {
    const made = await room();
    await signIn();
    await page.goto(made.path);
    await page.getByRole('button', { name: made.name, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Details of #${made.name}` });
    // The repositories are an owner's own tab (D-154).
    await dialog.getByRole('tab', { name: 'Integrations' }).click();
    const feeds = dialog.getByRole('region', { name: 'GitHub repositories' });
    await expect(feeds.getByText(/No repository is connected/)).toBeVisible();

    await feeds.getByLabel(/^Repository/).fill('acme/feeds');
    await feeds.getByLabel('Releases').check();
    await feeds.getByRole('button', { name: 'Connect' }).click();

    const setup = feeds.getByRole('region', { name: /Add this webhook to acme\/feeds/ });
    await expect(setup).toBeVisible();
    await expect(setup.getByText(/\/api\/webhooks\/github\/[0-9a-f-]{36}$/)).toBeVisible();
    await expect(setup.getByText('application/json')).toBeVisible();
    await expect(setup.getByText(/^[0-9a-f]{64}$/)).toBeVisible();
    await expectNoAxe(dialog);

    await setup.getByRole('button', { name: 'Done' }).click();
    await expect(feeds.getByText('acme/feeds')).toBeVisible();
    await expect(feeds.getByText(/Pushes, Releases · No delivery yet/)).toBeVisible();
    await expect(feeds.getByText(/^[0-9a-f]{64}$/)).toHaveCount(0);
  });

  test('its one repository is where the channel’s code references link (D-223)', async ({
    page,
    signIn,
    room,
    expectNoAxe,
  }) => {
    const made = await room({
      messages: [{ by: 'alice', text: 'Retries fail at src/retry.ts:14 since abc1234.' }],
    });
    await signIn();
    await page.goto(made.path);
    const words = page.getByText(/Retries fail at/);
    await expect(words).toBeVisible();
    // No feed yet: the words are words.
    await expect(page.locator('a[data-code-reference]')).toHaveCount(0);

    await page.getByRole('button', { name: made.name, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Details of #${made.name}` });
    await dialog.getByRole('tab', { name: 'Integrations' }).click();
    const feeds = dialog.getByRole('region', { name: 'GitHub repositories' });
    await feeds.getByLabel(/^Repository/).fill('acme/feeds');
    await feeds.getByRole('button', { name: 'Connect' }).click();
    await feeds.getByRole('button', { name: 'Done' }).click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    const references = page.locator('a[data-code-reference]');
    await expect(references).toHaveCount(2);
    await expect(references.nth(0)).toHaveAttribute(
      'href',
      'https://github.com/acme/feeds/blob/HEAD/src/retry.ts#L14',
    );
    await expect(references.nth(1)).toHaveAttribute(
      'href',
      'https://github.com/acme/feeds/commit/abc1234',
    );
    await expect(references.nth(0)).toHaveAttribute('target', '_blank');
    await expectNoAxe(page.locator('[data-message-body]').first());
  });

  test('a lost secret is regenerated: the old one is refused at once, the new one posts, the address is the same (#884)', async ({
    page,
    signIn,
    room,
    expectNoAxe,
  }) => {
    const made = await room();
    await signIn();
    await page.goto(made.path);
    await page.getByRole('button', { name: made.name, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Details of #${made.name}` });
    await dialog.getByRole('tab', { name: 'Integrations' }).click();
    const feeds = dialog.getByRole('region', { name: 'GitHub repositories' });
    await feeds.getByLabel(/^Repository/).fill('acme/feeds');
    await feeds.getByRole('button', { name: 'Connect' }).click();
    const setup = feeds.getByRole('region', { name: /Add this webhook to acme\/feeds/ });
    const address =
      (await setup.getByText(/\/api\/webhooks\/github\/[0-9a-f-]{36}$/).textContent()) ?? '';
    const path = new URL(address).pathname;
    const first = (await setup.getByText(/^[0-9a-f]{64}$/).textContent()) ?? '';
    await setup.getByRole('button', { name: 'Done' }).click();

    const deliver = async (secret: string, delivery: string, tip: string): Promise<number> =>
      (
        await page.request.post(path, {
          headers: {
            'content-type': 'application/json',
            'x-github-event': 'push',
            'x-github-delivery': delivery,
            'x-hub-signature-256': signedBy(secret, push(tip)),
          },
          data: push(tip),
        })
      ).status();
    expect(await deliver(first, 'e2e-first', 'b')).toBe(201);

    await feeds.getByRole('button', { name: 'Regenerate secret of acme/feeds' }).click();
    const question = feeds.getByRole('group', { name: /Regenerate the secret of acme\/feeds\?/ });
    await question.getByRole('button', { name: 'Regenerate secret' }).click();
    const fresh = feeds.getByRole('region', {
      name: /Give acme\/feeds’s webhook on GitHub its new secret/,
    });
    await expect(fresh).toBeVisible();
    // The same address, a different secret, shown once.
    await expect(fresh.getByText(address)).toBeVisible();
    const second = (await fresh.getByText(/^[0-9a-f]{64}$/).textContent()) ?? '';
    expect(second).not.toBe(first);
    await expectNoAxe(dialog);
    await fresh.getByRole('button', { name: 'Done' }).click();
    await expect(feeds.getByText(/^[0-9a-f]{64}$/)).toHaveCount(0);

    // GitHub, still with the old secret, is refused; with the new one it is let in.
    expect(await deliver(first, 'e2e-second', 'c')).toBe(401);
    expect(await deliver(second, 'e2e-second', 'c')).toBe(201);
  });
});
