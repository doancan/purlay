import { describe, expect, test } from 'bun:test';
import { EXTERNAL_LINK } from './external-link';

describe('a link that leaves the product', () => {
  test('opens a new tab that can neither reach back nor say where it came from', () => {
    expect(EXTERNAL_LINK.target).toBe('_blank');
    expect(EXTERNAL_LINK.rel.split(' ').sort()).toEqual(['noopener', 'noreferrer']);
  });
});
