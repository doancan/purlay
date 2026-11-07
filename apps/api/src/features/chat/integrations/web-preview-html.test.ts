/** Untrusted page metadata becomes bounded plain strings, never executable markup. */
import { expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { WebLinkPreviewResponse } from '@purlay/types';
import { previewHtml, WEB_PREVIEW_BYTES_MAX } from './web-preview-html';

const page = new URL('https://docs.example/reports/quarter#part');
const read = async (html: string): ReturnType<typeof previewHtml> =>
  await previewHtml(new TextEncoder().encode(html), page);

test('OpenGraph wins over fallback metadata, decodes entities once and resolves an image against the real page', async () => {
  expect(
    await read(`
    <base href="https://wrong.example/">
    <title>Fallback title</title><meta name="description" content="Fallback description">
    <META PROPERTY="OG:TITLE" CONTENT="Üretim &amp; kalite &#x1F600;">
    <meta property="og:description" content="  İlk vardiya\n  &amp; ikinci vardiya  ">
    <meta property="og:image" content="../assets/cover.png?x=1&copy=2&amp;y=3">
    <meta property="og:url" content="https://wrong.example/">
  `),
  ).toEqual({
    title: 'Üretim & kalite 😀',
    description: 'İlk vardiya & ikinci vardiya',
    imageUrl: 'https://docs.example/assets/cover.png?x=1&copy=2&y=3',
  });
});

test('text and attribute entity contexts differ, and an encoded entity is not decoded twice', async () => {
  expect(
    await read(
      '<title>A &amp=two &amp;lt;tag&amp;gt;</title><meta name="description" content="B &amp=two">',
    ),
  ).toEqual({
    title: 'A &=two &lt;tag&gt;',
    description: 'B &amp=two',
    imageUrl: null,
  });
  expect((await read('<meta property="og:title" content="&amp;lt;tag&amp;gt;">'))?.title).toBe(
    '&lt;tag&gt;',
  );
});

test('keeps the first usable metadata, while an empty OpenGraph value leaves the title fallback available', async () => {
  expect(
    await read(
      '<title>First title</title><title>Second title</title><meta property="og:title" content=" "><meta name="description" content="First"><meta name="description" content="Second">',
    ),
  ).toEqual({
    title: 'First title',
    description: 'First',
    imageUrl: null,
  });
});

test.each([
  '',
  '   ',
  'https://[',
  'http://cdn.example/cover.png',
  'javascript:alert(1)',
  'data:image/png;base64,AAAA',
  'https://127.0.0.1/cover.png',
  'https://[::1]/cover.png',
  'https://user:password@cdn.example/cover.png',
  'https://cdn.example:8443/cover.png',
  'https://localhost/cover.png',
])(
  'an absent or unsafe image %s does not discard a useful title or become a proxy target',
  async (url) => {
    expect(await read(`<title>Report</title><meta property="og:image" content="${url}">`)).toEqual({
      title: 'Report',
      description: null,
      imageUrl: null,
    });
  },
);

test('prefers a usable secure image and ignores a too-long image address', async () => {
  expect(
    (
      await read(
        '<title>Report</title><meta property="og:image" content="/plain.png"><meta property="og:image:secure_url" content="//cdn.example/secure.png">',
      )
    )?.imageUrl,
  ).toBe('https://cdn.example/secure.png');
  expect(
    (
      await read(
        `<title>Report</title><meta property="og:image" content="https://cdn.example/${'a'.repeat(2048)}">`,
      )
    )?.imageUrl,
  ).toBeNull();
});

test('bounds text, removes directional controls and never leaves a cut surrogate', async () => {
  const clipped = await read(
    `<meta property="og:title" content="${'a'.repeat(199)}😀"><meta name="description" content="${'b'.repeat(500)}">`,
  );
  expect(clipped?.title).toBe('a'.repeat(199));
  expect(clipped?.description).toBe('b'.repeat(400));
  expect(Value.Check(WebLinkPreviewResponse, clipped)).toBe(true);
  expect(
    await read('<title>A\u202EB\u2066C</title><meta name="description" content="\u200D">'),
  ).toEqual({ title: 'ABC', description: null, imageUrl: null });
});

test('scripts, empty/invisible titles, malformed bytes and oversized bodies produce no card', async () => {
  expect(
    await read('<script>const example = "<title>Not a document title</title>";</script>'),
  ).toBeNull();
  expect(await read('<meta name="description" content="Only a description">')).toBeNull();
  expect(await read('<meta property="og:title" content="\u200D">')).toBeNull();
  // Both controls contain a usable title: removing either refusal must actually produce a card.
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  expect(
    await previewHtml(new Uint8Array([...encode('<title>A'), 255, ...encode('</title>')]), page),
  ).toBeNull();
  expect(
    await previewHtml(encode(`<title>Report</title>${' '.repeat(WEB_PREVIEW_BYTES_MAX)}`), page),
  ).toBeNull();
});
