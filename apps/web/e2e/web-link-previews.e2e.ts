/** Browser presentation uses a metadata stand-in; the chat HTTP integration owns origin/authority proof. */
import { expect, test } from './fixtures';
import { apiAs, onEngine, WEBKIT_TAB } from './support';

const URL = 'https://docs.example/operations/shift-plan#handover';
const card = {
  title: 'Üretim ve sevkiyat planı <script>alert(1)</script>',
  description: 'Depo, satın alma ve üretim ekiplerinin ortak vardiya notları. '.repeat(4),
  imageUrl: 'https://images.example/shift-cover.png',
};
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
);

test('unavailable decorative code leaves the conversation and composer usable', async ({
  page,
  room,
  signIn,
}) => {
  const made = await room({ members: ['dogancan', 'bob'], messages: [{ by: 'bob', text: URL }] });
  let refused = 0;
  await page.route('**/assets/web-link-cards-visible-*.js', async (route) => {
    refused += 1;
    await route.abort('failed');
  });
  await signIn('dogancan');
  await page.goto(made.path);
  await expect.poll(() => refused).toBeGreaterThan(0);
  await expect(page.locator('[data-message-row]').getByRole('link', { name: URL })).toBeVisible();
  await expect(page.locator('[data-web-link-card]')).toHaveCount(0);
  const composer = page.getByRole('textbox', { name: `Message ${made.name}` });
  await composer.fill('The conversation still works');
  await composer.press('Enter');
  await expect(page.getByText('The conversation still works', { exact: true })).toBeVisible();
});

test('a freshly sent message gets its preview after the server has accepted it', async ({
  page,
  room,
  tenant,
  signIn,
}) => {
  const made = await room({ members: ['dogancan', 'bob'] });
  const reader = apiAs(tenant, 'dogancan');
  let checked = 0;
  await page.route('**/api/messages/*/link-preview', async (route) => {
    const id = new globalThis.URL(route.request().url()).pathname.split('/').at(-2);
    if (id === undefined) throw new Error('Missing message id');
    // A route bound to a message must never race ahead of the send that creates that message.
    const stored = await reader.get<{ content: string }>(`/api/messages/${id}`);
    expect(stored.content).toBe(URL);
    checked += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...card, imageUrl: null }),
    });
  });
  await signIn('dogancan');
  await page.goto(made.path);
  const composer = page.getByRole('textbox', { name: `Message ${made.name}` });
  await composer.fill(URL);
  await composer.press('Enter');
  await expect(page.locator('[data-web-link-card]')).toBeVisible();
  expect(checked).toBe(1);
});

test('a compact card keeps the real destination, proxy privacy and keyboard focus at 320px', async ({
  page,
  room,
  signIn,
  expectNoAxe,
}, info) => {
  const shown = {
    ...card,
    title: `Vardiya${'X'.repeat(160)}<script>1</script>`,
    description: 'Teslimat'.repeat(50),
  };
  const destination =
    'https://docs.example.partner.supplies-and-warehouse.example.net/operations/shift-plan#handover';
  const made = await room({
    members: ['dogancan', 'bob'],
    messages: [{ by: 'bob', text: `Güncel vardiya planı: ${destination}` }],
  });
  const originRequests: string[] = [];
  page.on('request', (request) => {
    if (new globalThis.URL(request.url()).hostname !== 'localhost')
      originRequests.push(request.url());
  });
  await page.route('**/api/messages/*/link-preview', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ url: destination });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(shown),
    });
  });
  await page.route('**/api/images?*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await signIn('dogancan');
  await page.goto(made.path);
  const preview = page.locator('[data-web-link-card]');
  await expect(preview).toBeVisible();
  const box = await preview.boundingBox();
  if (box === null) throw new Error('The card has no painted box');
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  const link = preview.getByRole('link');
  await expect(link).toHaveAttribute('href', destination);
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(preview).toContainText('docs.example');
  await expect(preview).toContainText(shown.title);
  const host = preview.getByText(new globalThis.URL(destination).hostname, { exact: true });
  expect(
    await host.evaluate(
      (node) => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight,
    ),
  ).toBe(true);
  await expect(preview.locator('script')).toHaveCount(0);
  await expect(preview.locator('img')).toHaveAttribute(
    'src',
    `/api/images?url=${encodeURIComponent(card.imageUrl)}`,
  );
  await expect
    .poll(
      async () =>
        await preview.locator('img').evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  expect(originRequests).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await link.focus();
  if (onEngine(info, 'webkit')) {
    // The harness measures WebKit's native link Tab preference separately; keep focus/ring assertions here.
    info.annotations.push({ type: 'keyboard-platform', description: WEBKIT_TAB });
    await page.keyboard.press('ArrowRight');
  } else {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
  }
  await expect(link).toBeFocused();
  expect(await link.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe('solid');
  await expectNoAxe();
  await page.screenshot({ path: info.outputPath('web-link-320.png'), fullPage: true });
});

test('a long feed fetches metadata only for visible messages and learns more while scrolling', async ({
  page,
  room,
  signIn,
}) => {
  const made = await room({
    members: ['dogancan', 'bob'],
    messages: Array.from({ length: 30 }, (_, index) => ({
      by: 'bob' as const,
      text: `Vardiya ${String(index)}\n\nDepo sayımı ve teslimat görüşmesi.\n\nhttps://docs.example/report/${String(index)}`,
    })),
  });
  const asked = new Set<string>();
  await page.route('**/api/messages/*/link-preview', async (route) => {
    const body = route.request().postDataJSON() as { url: string };
    asked.add(body.url);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...card, imageUrl: null }),
    });
  });
  await signIn('dogancan');
  await page.goto(made.path);
  await expect(page.locator('[data-web-link-card]').first()).toBeVisible();
  const initial = asked.size;
  expect(initial).toBeGreaterThan(0);
  expect(initial).toBeLessThan(20);
  const unseen = Array.from(
    { length: 30 },
    (_, index) => `https://docs.example/report/${String(index)}`,
  ).find((url) => !asked.has(url));
  if (unseen === undefined) throw new Error('Every offscreen document was fetched');
  const target = page
    .locator('[data-message-row]')
    .filter({ has: page.locator(`a[href="${unseen}"]`) });
  await target.scrollIntoViewIfNeeded();
  await expect(target.locator('[data-web-link-card]')).toBeVisible();
  expect(asked.size).toBeGreaterThan(initial);
});

test('the original link stays usable while pending and an edit removes late metadata', async ({
  page,
  room,
  tenant,
  signIn,
}) => {
  const made = await room({ members: ['dogancan', 'bob'] });
  const bob = apiAs(tenant, 'bob');
  const root = await bob.say(made.id, URL);
  const ready = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const answered = Promise.withResolvers<undefined>();
  await page.route('**/api/messages/*/link-preview', async (route) => {
    ready.resolve(undefined);
    await release.promise;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...card, imageUrl: null }),
    });
    answered.resolve(undefined);
  });
  await signIn('dogancan');
  await page.goto(made.path);
  await ready.promise;
  try {
    const row = page.locator('[data-message-row]').filter({ hasText: URL });
    await expect(row.getByRole('link', { name: URL })).toBeVisible();
    await bob.edit(root.id, 'Bu plan yenisiyle değiştirildi.');
    await expect(page.getByText('Bu plan yenisiyle değiştirildi.', { exact: true })).toBeVisible();
    release.resolve(undefined);
    await answered.promise;
    await expect(page.locator('[data-web-link-card]')).toHaveCount(0);
  } finally {
    release.resolve(undefined);
  }
});
