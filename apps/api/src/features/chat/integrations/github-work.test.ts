/**
 * A row of `github_links` as the contract says it (D-246): the address is built from the repository and the number,
 * and a row the table's own checks would have refused is a defect, said loudly rather than drawn.
 */
import { describe, expect, test } from 'bun:test';
import { workLinkOf } from './github-work';

const ROW = {
  id: '0194a000-0000-7000-8000-000000000001',
  repository_full_name: 'acme/api',
  kind: 'issue',
  number: 12,
  title: 'Retry',
  state: 'open',
  origin: 'created',
};

describe('a link as the contract says it', () => {
  test('builds its address from its parts, an issue and a pull request each by its own path', () => {
    expect(workLinkOf(ROW).url).toBe('https://github.com/acme/api/issues/12');
    expect(workLinkOf({ ...ROW, kind: 'pull', state: 'merged' }).url).toBe(
      'https://github.com/acme/api/pull/12',
    );
    expect(workLinkOf({ ...ROW, origin: 'linked' }).origin).toBe('linked');
  });

  test('refuses a kind or a state the table would not hold', () => {
    expect(() => workLinkOf({ ...ROW, kind: 'discussion' })).toThrow('unknown value');
    expect(() => workLinkOf({ ...ROW, state: 'draft' })).toThrow('unknown value');
  });
});
