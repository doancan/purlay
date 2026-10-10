/**
 * An icon is drawn one way: from a token size, in the one weight, hidden unless it
 * says something. The vocabulary check (`styles.test.ts`) already fails if any
 * class below stops being a token; these assert the behaviour around them.
 */
import { installDom } from '../testing/dom';
import { describe, expect, test } from 'bun:test';
import { render } from '@testing-library/react';
import { Icon, glyphNames } from './icon';

installDom();

describe('Icon', () => {
  test('is decorative by default: hidden from assistive technology, no role', () => {
    const { container } = render(<Icon name="channel" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('role')).toBeNull();
  });

  test('says what it is when given a label', () => {
    const { getByRole } = render(<Icon name="reply" label="Reply in thread" />);
    expect(getByRole('img', { name: 'Reply in thread' })).toBeDefined();
  });

  test.each([
    ['sm', 'size-icon-sm'],
    ['md', 'size-icon-md'],
    ['lg', 'size-icon-lg'],
  ] as const)('size %s uses the %s token, in the one weight', (size, token) => {
    const { container } = render(<Icon name="search" size={size} />);
    const classes = container.querySelector('svg')?.getAttribute('class') ?? '';
    expect(classes).toContain(token);
    expect(classes).toContain('icon-stroke');
    // The library draws at 24px by default; the class, not an attribute, sets the size.
    expect(classes.split(' ').filter((name) => name.startsWith('size-icon-'))).toEqual([token]);
  });

  test('defaults to the medium size, the one that sits on a line of body text', () => {
    const { container } = render(<Icon name="search" />);
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('size-icon-md');
  });

  test('draws every glyph in the vocabulary', () => {
    expect(glyphNames.length).toBeGreaterThan(10);
    for (const name of glyphNames) {
      const { container, unmount } = render(<Icon name={name} />);
      expect(container.querySelector('svg')).not.toBeNull();
      unmount();
    }
  });

  test('has no second weight to ask for: the stroke is a class, never an attribute the caller sets', () => {
    const { container } = render(<Icon name="close" />);
    // The library writes its own default attribute; the class beats it. What must
    // never happen is the weight arriving from a prop, which Icon does not take.
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('icon-stroke');
  });
});
