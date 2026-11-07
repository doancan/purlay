import type { Locator, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';
import { invoicePdf, overLimitImagePdf } from './pdf-fixture';

// Every case uploads through the UI. Run this file's cases independently in sequence so this
// specification alone cannot exceed the node's four concurrent in-memory uploads (D-109).
// `default`, rather than `serial`, keeps subsequent cases running after an individual failure.
test.describe.configure({ mode: 'default' });

const upload = async (
  page: Page,
  channel: string,
  name: string,
  bytes: Buffer,
  text: string,
): Promise<Locator> => {
  await expect(page.getByRole('textbox', { name: `Message ${channel}` })).toBeVisible();
  const uploaded = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/uploads'),
  );
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: 'application/pdf', buffer: bytes });
  const accepted = await uploaded;
  if (accepted.status() !== 201)
    throw new Error(
      `PDF fixture upload answered ${String(accepted.status())}: ${await accepted.text()}`,
    );
  const files = page.getByRole('list', { name: 'Files to send' });
  await expect(files.getByText(name)).toBeVisible();
  await expect(files.getByText(/Uploading/)).toHaveCount(0);
  const composer = page.getByRole('textbox', { name: `Message ${channel}` });
  await composer.fill(text);
  await composer.press('Enter');
  const row = page.locator('[data-message-row]', { hasText: text });
  await expect(row.getByRole('button', { name: `Preview ${name}` })).toBeVisible();
  return row;
};

test('a PDF opens only on request, renders both pages, zooms within the conversation and terminates on close', async ({
  page,
  room,
  signIn,
  expectNoAxe,
}) => {
  const made = await room({ members: ['dogancan', 'bob'] });
  let readerRequests = 0;
  page.on('request', (request) => {
    if (/\/assets\/pdf-(?:preview|reader|worker)-/.test(new URL(request.url()).pathname))
      readerRequests += 1;
  });
  await signIn('bob');
  await page.goto(made.path);
  let workers = 0;
  let closed = 0;
  page.on('worker', (worker) => {
    workers += 1;
    worker.on('close', () => {
      closed += 1;
    });
  });
  const row = await upload(
    page,
    made.name,
    'quotation.pdf',
    invoicePdf(),
    'Please review this quotation.',
  );
  expect(workers).toBe(0);
  expect(readerRequests).toBe(0);
  await row.getByRole('button', { name: 'Preview quotation.pdf' }).click();
  const reader = row.getByRole('region', { name: 'Preview of quotation.pdf' });
  await expect(reader.getByRole('document', { name: 'Text on PDF page 1' })).toContainText(
    'Quotation Purlay',
  );
  expect(workers).toBe(1);
  expect(readerRequests).toBeGreaterThan(0);
  const title = reader.getByRole('document').locator('span', { hasText: 'Quotation Purlay' });
  await title.scrollIntoViewIfNeeded();
  const box = await title.boundingBox();
  if (box === null) throw new Error('the selectable title has no painted geometry');
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('Quotation');
  expect(await page.evaluate((): unknown => Reflect.get(globalThis, 'PURLAY_BAD_PDF'))).not.toBe(
    true,
  );
  await reader.getByRole('button', { name: 'Next PDF page' }).click();
  await expect(reader.getByRole('document', { name: 'Text on PDF page 2' })).toContainText(
    'Second page complete.',
  );
  await reader.getByRole('combobox', { name: 'PDF zoom' }).selectOption('2');
  await expect(reader.getByRole('button', { name: 'Previous PDF page' })).toBeEnabled();
  await expect(reader.getByRole('document', { name: 'Text on PDF page 2' })).toContainText(
    'Second page complete.',
  );
  // A zoomed document scrolls locally; it must not repeatedly enlarge its own measured viewport.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await reader.getByRole('combobox', { name: 'PDF page' }).selectOption('1');
  await expect(reader.getByRole('document', { name: 'Text on PDF page 1' })).toContainText(
    'Quotation Purlay',
  );
  await expectNoAxe(reader);
  // Escape from the artifact closes the reader. A focused icon's tooltip has its own Escape layer.
  const readingArea = reader.getByRole('region', { name: 'PDF page 1' });
  await readingArea.focus();
  await readingArea.press('Escape');
  await expect(reader).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Preview quotation.pdf' })).toBeFocused();
  await expect.poll(() => closed).toBe(workers);
  await expect(row.getByRole('link', { name: /Download quotation.pdf/ })).toHaveAttribute(
    'download',
    'quotation.pdf',
  );
});

test('both JPEG and JPEG2000 scan pages render real pixels with the same-origin JavaScript decoder', async ({
  page,
  room,
  signIn,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  await signIn('alice');
  await page.goto(made.path);
  let fallback = false;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/openjpeg_nowasm_fallback.js')) fallback = true;
  });
  const row = await upload(
    page,
    made.name,
    'scanned.pdf',
    readFileSync(new URL('./fixtures/scanned-codecs.pdf', import.meta.url)),
    'Scanned delivery note fixture.',
  );
  await row.getByRole('button', { name: 'Preview scanned.pdf' }).click();
  const reader = row.getByRole('region', { name: 'Preview of scanned.pdf' });
  for (const number of [1, 2]) {
    const image = reader.getByRole('img', { name: `PDF page ${String(number)}` });
    await expect(image).toBeVisible();
    const red = await image.evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('the actual canvas has no 2D context');
      return Array.from(
        context.getImageData(Math.floor(canvas.width / 4), Math.floor(canvas.height / 4), 1, 1)
          .data,
      );
    });
    expect(red[0]).toBeGreaterThan(220);
    expect(red[1]).toBeLessThan(60);
    expect(red[3]).toBe(255);
    await expect(reader.getByRole('document')).toHaveCount(0);
    if (number === 1) await reader.getByRole('button', { name: 'Next PDF page' }).click();
  }
  expect(fallback).toBe(true);
});

test('a failed JPEG2000 decoder closes the worker and explains the unreadable page', async ({
  page,
  room,
  signIn,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  await signIn('alice');
  await page.goto(made.path);
  let refused = false;
  let closed = 0;
  page.on('worker', (worker) => {
    worker.on('close', () => {
      closed += 1;
    });
  });
  await page.route('**/openjpeg_nowasm_fallback.js', async (route) => {
    refused = true;
    await route.abort('failed');
  });
  const row = await upload(
    page,
    made.name,
    'decoder-failure.pdf',
    readFileSync(new URL('./fixtures/scanned-codecs.pdf', import.meta.url)),
    'Controlled decoder failure fixture.',
  );
  await row.getByRole('button', { name: 'Preview decoder-failure.pdf' }).click();
  const reader = row.getByRole('region', { name: 'Preview of decoder-failure.pdf' });
  await expect(reader.getByRole('img', { name: 'PDF page 1' })).toBeVisible();
  await reader.getByRole('button', { name: 'Next PDF page' }).click();
  await expect(reader.getByRole('alert')).toContainText('The file could not be read.');
  expect(refused).toBe(true);
  await expect.poll(() => closed).toBe(1);
  await expect(reader.getByRole('img')).toHaveCount(0);
  await expect(reader.getByRole('document')).toHaveCount(0);
  await expect(reader.getByRole('link', { name: /Download decoder-failure.pdf/ })).toBeVisible();
});

test('the document and actual worker both recover a missing baseline capability', async ({
  page,
  room,
  signIn,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  await page.addInitScript(() => {
    Reflect.deleteProperty(Promise, 'withResolvers');
  });
  let patched = false;
  await page.route('**/assets/pdf-worker-*.js', async (route) => {
    const response = await route.fetch();
    patched = true;
    await route.fulfill({
      response,
      body:
        "Reflect.deleteProperty(Promise,'withResolvers');Reflect.set(globalThis,'PURLAY_BEFORE_PDF_SHIM',typeof Reflect.get(Promise,'withResolvers'));\n" +
        (await response.text()),
    });
  });
  await signIn('alice');
  await page.goto(made.path);
  const row = await upload(
    page,
    made.name,
    'capability.pdf',
    invoicePdf(),
    'Compatibility fixture.',
  );
  expect(await page.evaluate(() => typeof Reflect.get(Promise, 'withResolvers'))).toBe('undefined');
  const workerReady = page.waitForEvent('worker');
  await row.getByRole('button', { name: 'Preview capability.pdf' }).click();
  const worker = await workerReady;
  await expect(row.getByRole('document', { name: 'Text on PDF page 1' })).toContainText(
    'Quotation Purlay',
  );
  expect(patched).toBe(true);
  expect(
    await worker.evaluate((): unknown => Reflect.get(globalThis, 'PURLAY_BEFORE_PDF_SHIM')),
  ).toBe('undefined');
  expect(await worker.evaluate(() => typeof Reflect.get(Promise, 'withResolvers'))).toBe(
    'function',
  );
  expect(await page.evaluate(() => typeof Reflect.get(Promise, 'withResolvers'))).toBe('function');
});

test('a malformed and an encrypted PDF stay explicit and downloadable', async ({
  page,
  room,
  signIn,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  await signIn('alice');
  await page.goto(made.path);
  for (const fixture of [
    {
      name: 'malformed.pdf',
      bytes: Buffer.from('%PDF-1.7\nnot a document'),
      text: 'The file could not be read.',
    },
    {
      name: 'password.pdf',
      bytes: readFileSync(new URL('./fixtures/password.pdf', import.meta.url)),
      text: 'This PDF needs a password.',
    },
  ]) {
    const row = await upload(page, made.name, fixture.name, fixture.bytes, `Check ${fixture.name}`);
    await row.getByRole('button', { name: `Preview ${fixture.name}` }).click();
    const reader = row.getByRole('region', { name: `Preview of ${fixture.name}` });
    await expect(reader.getByRole('alert')).toContainText(fixture.text);
    await expect(reader.getByRole('document')).toHaveCount(0);
    await expect(
      reader.getByRole('link', { name: new RegExp(`Download ${fixture.name}`) }),
    ).toBeVisible();
    await reader.getByRole('button', { name: `Hide the preview of ${fixture.name}` }).click();
  }
});

test('a long file name and page controls reflow at 320px, with a readable 400% zoom', async ({
  page,
  room,
  signIn,
  expectNoAxe,
}, testInfo) => {
  const made = await room({ members: ['dogancan', 'bob'] });
  await signIn('bob');
  await page.setViewportSize({ width: 320, height: 850 });
  await page.goto(made.path);
  const name = `Satış teklif şartları ${'Ğışöçü'.repeat(12)}.pdf`;
  const row = await upload(page, made.name, name, invoicePdf(), 'Narrow PDF reader fixture.');
  await row.getByRole('button', { name: `Preview ${name}` }).click();
  const reader = row.getByRole('region', { name: `Preview of ${name}` });
  await expect(reader.getByRole('document', { name: 'Text on PDF page 1' })).toContainText(
    'Quotation Purlay',
  );
  await reader.getByRole('combobox', { name: 'PDF zoom' }).selectOption('4');
  await expect(reader.getByRole('button', { name: 'Next PDF page' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expectNoAxe(reader);
  await testInfo.attach('pdf-reader-320', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('removing an active reader from its channel closes its worker and withdraws the document', async ({
  page,
  room,
  signIn,
  asPerson,
  api,
  tenant,
}) => {
  const made = await room({ members: ['dogancan', 'alice', 'bob'] });
  await signIn('bob');
  await page.goto(made.path);
  await upload(page, made.name, 'private.pdf', invoicePdf(), 'Private document fixture.');
  const alice = await asPerson('alice');
  let started = 0;
  let closed = 0;
  alice.on('worker', (worker) => {
    started += 1;
    worker.on('close', () => {
      closed += 1;
    });
  });
  await alice.goto(made.path);
  const row = alice.locator('[data-message-row]', { hasText: 'Private document fixture.' });
  await row.getByRole('button', { name: 'Preview private.pdf' }).click();
  await expect(row.getByRole('document', { name: 'Text on PDF page 1' })).toContainText(
    'Quotation Purlay',
  );
  await api('dogancan').del(`/api/channels/${made.id}/members/${tenant.userIds.alice}`);
  await expect(alice.getByRole('region', { name: 'Preview of private.pdf' })).toHaveCount(0);
  await expect.poll(() => closed).toBe(started);
  expect(started).toBe(1);
});

test('a refused image is an explicit failure rather than a successful blank PDF page', async ({
  page,
  room,
  signIn,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  await signIn('alice');
  await page.goto(made.path);
  const row = await upload(
    page,
    made.name,
    'large-image.pdf',
    overLimitImagePdf(),
    'A controlled image limit fixture.',
  );
  await row.getByRole('button', { name: 'Preview large-image.pdf' }).click();
  const reader = row.getByRole('region', { name: 'Preview of large-image.pdf' });
  await expect(reader.getByRole('alert')).toContainText(
    'This document exceeds the preview limits.',
  );
  await expect(reader.getByRole('document')).toHaveCount(0);
  await expect(reader.getByRole('button', { name: 'Next PDF page' })).toBeDisabled();
  await expect(reader.getByRole('link', { name: /Download large-image.pdf/ })).toBeVisible();
});
