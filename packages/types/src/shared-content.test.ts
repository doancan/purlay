/** The Shared catalogue preserves long valid message URLs while bounding its wire representation. */
import { expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { MESSAGE_CONTENT_MAX } from './models';
import { SharedLink, SHARED_LINK_URL_MAX } from './shared-content';

test('shared link contract accepts ordinary corporate HTTP(S) URLs and rejects other protocols', () => {
  for (const url of ['http://erp/order/42', 'https://example.com/report#review'])
    expect(Value.Check(SharedLink, { url, label: 'Report' })).toBe(true);
  for (const url of ['javascript:alert(1)', 'mailto:ops@example.com', '/internal'])
    expect(Value.Check(SharedLink, { url, label: 'Report' })).toBe(false);
  expect(Value.Check(SharedLink, { url: 'https://example.com', label: '' })).toBe(false);
});

test('shared link fields have explicit bounds, including normalized long targets', () => {
  const prefix = 'https://example.com/';
  const url = prefix + 'x'.repeat(SHARED_LINK_URL_MAX - prefix.length);
  expect(Value.Check(SharedLink, { url, label: 'x'.repeat(MESSAGE_CONTENT_MAX) })).toBe(true);
  expect(Value.Check(SharedLink, { url: url + 'x', label: 'Report' })).toBe(false);
  expect(Value.Check(SharedLink, { url: prefix, label: 'x'.repeat(MESSAGE_CONTENT_MAX + 1) })).toBe(
    false,
  );
});
