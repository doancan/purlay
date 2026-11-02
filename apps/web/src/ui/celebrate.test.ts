import { describe, expect, mock, test } from 'bun:test';
import { PARTY_POPPER, celebrate, hasPartyPopper, onCelebrate } from './celebrate';

describe('celebrate', () => {
  test('only text carrying the party popper asks for fireworks', () => {
    expect(hasPartyPopper(`shipped ${PARTY_POPPER}`)).toBe(true);
    expect(hasPartyPopper('shipped')).toBe(false);
  });

  test('a listener hears each celebration until it stops', () => {
    const heard = mock(() => undefined);
    const stop = onCelebrate(heard);
    celebrate();
    celebrate();
    stop();
    celebrate();
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
