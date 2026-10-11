/**
 * A link's address is made by the check or not at all (D-101 §9). The type-level half is asserted
 * with `@ts-expect-error`: each marked line must fail to compile, and the typecheck fails if one ever
 * compiles.
 */
import { describe, expect, test } from 'bun:test';
import { SafeHref } from './href';
import type { Inline } from './tree';

describe('SafeHref.of', () => {
  test.each([
    ['https://a.example/x', 'https://a.example/x'],
    ['http://b.example', 'http://b.example/'],
    ['mailto:c@d.example', 'mailto:c@d.example'],
    ['HTTPS://A.EXAMPLE', 'https://a.example/'],
  ])('allows %s, as the browser reads it', (url, href) => {
    expect(SafeHref.of(url)?.href).toBe(href);
  });

  test.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,x',
    'vbscript:x',
    'ftp://e.example',
    'file:///etc/passwd',
    '/relative',
    '//host.example/x',
    '',
  ])('refuses %s', (url) => {
    expect(SafeHref.of(url)).toBeNull();
  });
});

describe('nothing else makes one', () => {
  test('an object with an href, a string, or the constructor do not compile as an address', () => {
    // @ts-expect-error an object literal is not a SafeHref: it has no private field
    const literal: SafeHref = { href: 'javascript:alert(1)' };
    // @ts-expect-error a link's url is never a string
    const link: Inline = { type: 'link', url: 'javascript:alert(1)', children: [] };
    const construct = (): unknown =>
      // @ts-expect-error the constructor is private: the check is the only way in
      new SafeHref('javascript:alert(1)');
    // Nor at run time: neither value carries the private field. (A spread of a real one is
    // refused by lint, `no-misused-spread`, before the type system is asked.)
    expect(literal instanceof SafeHref).toBe(false);
    expect('url' in link && link.url instanceof SafeHref).toBe(false);
    expect(typeof construct).toBe('function');
  });
});

describe('a checked address stays checked', () => {
  test('neither it, its prototype nor its class can be redefined after the check', () => {
    const real = SafeHref.of('https://a.example');
    if (real === null) throw new Error('expected an address');
    const evil = { get: (): string => 'javascript:alert(1)' };
    expect(() => Object.defineProperty(real, 'href', evil)).toThrow(TypeError);
    expect(() => Object.defineProperty(SafeHref.prototype, 'href', evil)).toThrow(TypeError);
    expect(() => Object.defineProperty(SafeHref, 'of', { value: () => real })).toThrow(TypeError);
    expect(real.href).toBe('https://a.example/');
  });
});
