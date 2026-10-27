/**
 * An attachment, the whole way (#387, D-109, D-117): picked in one browser, uploaded with its progress,
 * sent with the words, and seen as an image by the other person — through the real API, its edge, its
 * re-encoding and the directory store the harness runs on.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openPanel } from './support';

/** A 2×2 PNG, red and blue: small, and a real image the API decodes and re-encodes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
);

const rowWith = (page: Page, text: string): Locator =>
  page.locator('[data-message-row]', { hasText: text });

test.describe('an attachment', () => {
  test('picked, uploaded, sent with the words, and seen by the other person as an image', async ({
    page,
    signIn,
    room,
    asPerson,
  }) => {
    const made = await room({ messages: [{ by: 'alice', text: 'send me the diagram' }] });
    await signIn();
    await page.goto(made.path);
    const composer = page.getByRole('textbox', { name: `Message ${made.name}` });
    await expect(composer).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles({
      name: 'diagram.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    const files = page.getByRole('list', { name: 'Files' });
    await expect(files.getByText('diagram.png')).toBeVisible();
    // Landed: the chip says its stored size rather than that it is uploading.
    await expect(files.getByText(/Uploading/)).toHaveCount(0);

    await composer.fill('here it is');
    await composer.press('Enter');
    await expect(
      rowWith(page, 'here it is').getByRole('img', { name: 'diagram.png' }),
    ).toBeVisible();

    const alice = await asPerson('alice');
    await alice.goto(made.path);
    const image = rowWith(alice, 'here it is').getByRole('img', { name: 'diagram.png' });
    await expect(image).toBeVisible();
    // Drawn from the API's own re-encoding, never a public address.
    expect(await image.getAttribute('src')).toMatch(/^\/api\/attachments\/[0-9a-f-]+\/thumbnail$/);
    // Decoded, not only laid out: visible is true of an image whose bytes are still on their way,
    // and read at once its width was sometimes still 0 under the full suite's load (#347).
    await expect
      .poll(async () => await image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);
  });

  test('a file with no words enables Send and is downloaded unchanged by the other person', async ({
    page,
    signIn,
    room,
    asPerson,
  }) => {
    const made = await room({ messages: [{ by: 'alice', text: 'send just the file' }] });
    await signIn();
    await page.goto(made.path);
    await expect(page.getByRole('textbox', { name: `Message ${made.name}` })).toBeVisible();
    const bytes = Buffer.from('Türkçe dosya içeriği: ğışöçü.\n');
    const name = 'denetim-ğış.txt';
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name, mimeType: 'text/plain', buffer: bytes });
    const files = page.getByRole('list', { name: 'Files to send' });
    await expect(files.getByText(name)).toBeVisible();
    await expect(files.getByText(/Uploading/)).toHaveCount(0);
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await expect(send).toBeEnabled();
    await send.click();
    await expect(files).toHaveCount(0);
    await expect(send).toBeDisabled();

    const alice = await asPerson('alice');
    await alice.goto(made.path);
    const download = alice.getByRole('link', { name: `Download ${name}` });
    await expect(download).toBeVisible();
    const href = await download.getAttribute('href');
    if (href === null) throw new Error('the file has no download URL');
    const response = await alice.request.get(href);
    expect(response.ok()).toBe(true);
    expect(await response.body()).toEqual(bytes);
  });

  test('a thumbnail opens the image viewer over the window, and Esc gives the feed back (D-159)', async ({
    page,
    signIn,
    room,
  }) => {
    const made = await room({ messages: [{ by: 'alice', text: 'what does it look like' }] });
    await signIn();
    await page.goto(made.path);
    await page.locator('input[type="file"]').setInputFiles({
      name: 'diagram.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    const files = page.getByRole('list', { name: 'Files' });
    await expect(files.getByText('diagram.png')).toBeVisible();
    await expect(files.getByText(/Uploading/)).toHaveCount(0);
    const composer = page.getByRole('textbox', { name: `Message ${made.name}` });
    await composer.fill('like this');
    await composer.press('Enter');

    const thumbnail = rowWith(page, 'like this').getByRole('link', { name: 'Open diagram.png' });
    await thumbnail.click();
    const viewer = page.getByRole('dialog', { name: 'diagram.png' });
    await expect(viewer).toBeVisible();
    // The full image, from the API, decoded in place: not a new tab.
    const full = viewer.getByRole('img', { name: 'diagram.png' });
    await expect
      .poll(async () => await full.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);
    expect(await full.getAttribute('src')).toMatch(/^\/api\/attachments\/[0-9a-f-]+$/);
    await expect(viewer.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'download',
      'diagram.png',
    );
    expect(page.context().pages()).toHaveLength(1);

    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    await expect(thumbnail).toBeFocused();
  });

  test('shared by one person, it appears in the other’s Files panel as it arrives (D-129)', async ({
    page,
    signIn,
    room,
    asPerson,
  }) => {
    const made = await room({ messages: [{ by: 'alice', text: 'the files are coming' }] });
    await signIn();
    await page.goto(made.path);
    await openPanel(page, 'Files in this channel');
    const panel = page.getByRole('complementary', { name: /^Files/ });
    await expect(panel.getByRole('heading', { name: 'No files yet' })).toBeVisible();

    const alice = await asPerson('alice');
    await alice.goto(made.path);
    await alice.locator('input[type="file"]').setInputFiles({
      name: 'diagram.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    const sending = alice.getByRole('list', { name: 'Files to send' });
    await expect(sending.getByText('diagram.png')).toBeVisible();
    await expect(sending.getByText(/Uploading/)).toHaveCount(0);
    const composer = alice.getByRole('textbox', { name: `Message ${made.name}` });
    await composer.fill('the diagram');
    await composer.press('Enter');

    // Told by the socket, read again: no reload on this side.
    await expect(panel.getByRole('link', { name: 'Open diagram.png' })).toBeVisible();
    await expect(panel.getByText('alice', { exact: false }).first()).toBeVisible();
  });
});
