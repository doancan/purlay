/**
 * The shell renders.
 *
 * The point is not the markup — there is almost none. It is that the component
 * harness genuinely works: a real render, in a real DOM, asserted through the
 * accessible tree rather than through a class name. A test that asserted
 * `className` would pass with the styling layer uninstalled.
 */
import { installDom } from './testing/dom';
import { describe, expect, test } from 'bun:test';
import { render } from '@testing-library/react';
import { Shell } from './shell';

installDom();

describe('the shell', () => {
  test('renders, and is reachable through the accessible tree', () => {
    // The queries `render` returns, not the global `screen` — see testing/dom.ts.
    const { getByRole } = render(<Shell />);
    expect(getByRole('heading', { name: 'Purlay' })).toBeDefined();
    expect(getByRole('main')).toBeDefined();
  });
});
