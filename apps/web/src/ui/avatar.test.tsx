import { describe, expect, test } from 'bun:test';
import { render } from '@testing-library/react';
import { installDom } from '../testing/dom';
import { Avatar, initialsOf, tintOf } from './avatar';

installDom();

describe('initials', () => {
  test.each([
    ['Alice Chen', 'AC'],
    ['dogancan', 'DO'],
    ['bob.okafor', 'BO'],
    ['carol-reyes-smith', 'CR'],
    ['  ', '?'],
    ['', '?'],
    ['İlker Şahin', 'İŞ'],
    ['😀 smile', '😀S'],
  ])('%s is %s', (name, expected) => {
    expect(initialsOf(name)).toBe(expected);
  });
});

describe('the tint', () => {
  test('is the same for the same handle and always one of the six', () => {
    expect(tintOf('alice')).toBe(tintOf('alice'));
    const seen = new Set(
      ['alice', 'bob', 'carol', 'dogancan', 'erin', 'frank', 'grace', 'heidi'].map(tintOf),
    );
    for (const tint of seen) {
      expect(tint).toBeGreaterThanOrEqual(0);
      expect(tint).toBeLessThan(6);
    }
    expect(seen.size).toBeGreaterThan(2);
  });

  test('is chosen from the handle, not from the display name that can change', () => {
    const one = render(<Avatar name="Alice" username="alice" />);
    const two = render(<Avatar name="Alice Chen-Reyes" username="alice" />);
    const tint = (node: HTMLElement): string | undefined =>
      node.className.split(' ').find((name) => name.startsWith('bg-avatar'));
    expect(tint(one.container.firstElementChild as HTMLElement)).toBe(
      tint(two.container.firstElementChild as HTMLElement),
    );
  });
});

describe('the avatar', () => {
  test('is decorative: the name beside it is what is read', () => {
    const view = render(<Avatar name="Alice Chen" username="alice" size="lg" />);
    const node = view.container.firstElementChild as HTMLElement;
    expect(node.getAttribute('aria-hidden')).toBe('true');
    expect(node.textContent).toBe('AC');
    expect(node.className).toContain('size-avatar-lg');
  });

  test('online draws a dot inside the hidden avatar; offline or unknown draws none (D-136)', () => {
    for (const [online, dots] of [
      [true, 1],
      [false, 0],
      [undefined, 0],
    ] as const) {
      const view = render(<Avatar name="Alice Chen" username="alice" online={online} />);
      const node = view.container.firstElementChild as HTMLElement;
      expect(node.querySelectorAll('[data-online]')).toHaveLength(dots);
      // The dot is inside what a screen reader skips: the words beside the name say it.
      expect(node.getAttribute('aria-hidden')).toBe('true');
      view.unmount();
    }
  });

  test('is a rounded square, not a circle: a person, in a tool (D-110)', () => {
    for (const [size, corner] of [
      ['sm', 'rounded-md'],
      ['md', 'rounded-lg'],
      ['lg', 'rounded-lg'],
    ] as const) {
      const view = render(<Avatar name="Alice Chen" username="alice" size={size} />);
      const node = view.container.firstElementChild as HTMLElement;
      expect(node.className).toContain(corner);
      expect(node.className).not.toContain('rounded-pill');
      view.unmount();
    }
  });
});

describe('one letter', () => {
  test('is the first of the two, for where avatars overlap (D-166)', () => {
    const view = render(<Avatar name="Çiğdem Öz" username="cigdem" letters={1} />);
    expect(view.container.textContent).toBe('Ç');
  });
});
