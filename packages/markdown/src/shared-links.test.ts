/** A company's link catalogue follows rendered links, without the public-preview two-candidate limit. */
import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from './parse';
import { sharedLinksOf } from './shared-links';

describe('links shared in conversation', () => {
  test('includes public, intranet, ERP, GitHub and image links beyond the preview limit', () => {
    expect(
      sharedLinksOf(
        parseMarkdown(
          '[Order](http://erp.local/order/42) https://example.com/a https://github.com/o/r/pull/1 https://example.com/image.png',
        ),
      ).map((link) => link.url),
    ).toEqual([
      'http://erp.local/order/42',
      'https://example.com/a',
      'https://github.com/o/r/pull/1',
      'https://example.com/image.png',
    ]);
  });
  test('deduplicates canonical addresses and retains the first label and document fragment', () => {
    expect(
      sharedLinksOf(
        parseMarkdown(
          '[Report](https://EXAMPLE.com:443/report?q=1#review) [Copy](https://example.com/report?q=1#review)',
        ),
      ),
    ).toEqual([{ url: 'https://example.com/report?q=1#review', label: 'Report' }]);
  });
  test('skips code, unsafe schemes, mail and credential-bearing addresses', () => {
    expect(
      sharedLinksOf(
        parseMarkdown(
          '`https://example.com/code`\n\n```txt\nhttps://example.com/fence\n```\n\n[bad](javascript:alert) [email](mailto:ops@example.com) [secret](https://user:password@example.com/private)',
        ),
      ),
    ).toEqual([]);
  });
  test('finds links in headings, quotations, lists and tables with plain labels', () => {
    expect(
      sharedLinksOf(
        parseMarkdown(
          '# [**Policy**](https://example.com/policy)\n\n> [Handbook](https://example.com/handbook)\n\n- [Invoice](http://erp/invoice)\n\n| Document |\n|---|\n| [Quarterly `report`](https://example.com/report) |',
        ),
      ).map((link) => link.label),
    ).toEqual(['Policy', 'Handbook', 'Invoice', 'Quarterly report']);
  });
  test('a body rendered as plain text has no rendered links to index', () => {
    expect(sharedLinksOf(null)).toEqual([]);
  });
});
