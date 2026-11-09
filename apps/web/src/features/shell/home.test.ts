/**
 * The address a workspace's name suggests: the part of it a URL keeps. Turkish letters are folded to
 * their plain ones, as a channel name's are, not dropped.
 */
import { describe, expect, test } from 'bun:test';
import { SLUG, slugOf } from './home';

describe('the address a workspace name suggests', () => {
  test.each([
    ['Acme Engineering', 'acme-engineering'],
    ['Çağrı Merkezi', 'cagri-merkezi'],
    ['İstanbul Ekibi', 'istanbul-ekibi'],
    ['IŞIK Ltd', 'isik-ltd'],
    ['ırmak', 'irmak'],
    ['Café Crème', 'cafe-creme'],
    ['  --Ops & Co--  ', 'ops-co'],
  ])('%p becomes %p', (name, wanted) => {
    expect(slugOf(name)).toBe(wanted);
    expect(slugOf(name) === '' || SLUG.test(slugOf(name))).toBe(true);
  });

  test('is never longer than an address may be', () => {
    expect(slugOf('ç'.repeat(100)).length).toBe(64);
  });
});
