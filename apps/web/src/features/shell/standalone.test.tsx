/**
 * The ground a card without the shell stands on: a card whose height is settled is centred; one that grows once
 * something loads stands at the top, so nothing in it moves under a pointer on its way to it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { installDom } from '../../testing/dom';
import { StandaloneScreen } from './standalone';

installDom();
afterEach(cleanup);

const placed = (placement?: 'centre' | 'top'): string[] => {
  const { container } = render(
    <StandaloneScreen {...(placement === undefined ? {} : { placement })}>
      <p>card</p>
    </StandaloneScreen>,
  );
  const main = container.querySelector('main');
  return (main?.className ?? '').split(' ');
};

describe('where a standalone card stands', () => {
  test('centred unless it says otherwise', () => {
    expect(placed()).toContain('items-center');
    expect(placed()).not.toContain('items-start');
  });

  test('at the top when its height can change after it is drawn', () => {
    expect(placed('top')).toContain('items-start');
    expect(placed('top')).not.toContain('items-center');
  });
});
