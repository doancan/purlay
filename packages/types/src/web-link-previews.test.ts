/** Plain, bounded optional decorations of links already present in readable messages. */
import { expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { WebLinkPreviewRequest, WebLinkPreviewResponse } from './web-link-previews';

test('a preview request names one HTTPS link, with no extra input or unbounded address', () => {
  expect(Value.Check(WebLinkPreviewRequest, { url: 'https://docs.example/report#section' })).toBe(
    true,
  );
  for (const input of [
    {},
    { url: 1 },
    { url: '' },
    { url: 'https://' },
    { url: 'http://docs.example/' },
    { url: 'javascript:alert(1)' },
    { url: 'ftp://docs.example/' },
    { url: 'https://docs.example/\nsecret' },
    { url: `https://docs.example/${'a'.repeat(2048)}` },
    { url: 'https://docs.example/', workspaceId: 'another' },
  ])
    expect(Value.Check(WebLinkPreviewRequest, input)).toBe(false);
});

test('a preview is absent or bounded text and an optional HTTPS image', () => {
  const card = { title: 'Vardiya & kalite 😀', description: null, imageUrl: null };
  expect(Value.Check(WebLinkPreviewResponse, null)).toBe(true);
  expect(Value.Check(WebLinkPreviewResponse, card)).toBe(true);
  expect(
    Value.Check(WebLinkPreviewResponse, {
      ...card,
      title: 'a'.repeat(200),
      description: 'a'.repeat(400),
      imageUrl: 'https://cdn.example/cover.png',
    }),
  ).toBe(true);
  for (const broken of [
    { ...card, title: '' },
    { ...card, title: 'a'.repeat(201) },
    { ...card, title: 'hidden\u0000value' },
    { ...card, title: 'file\u202Etxt' },
    { ...card, description: 'a'.repeat(401) },
    { ...card, imageUrl: 'http://cdn.example/cover.png' },
    { ...card, imageUrl: 'data:image/png;base64,AAAA' },
  ])
    expect(Value.Check(WebLinkPreviewResponse, broken)).toBe(false);
});
