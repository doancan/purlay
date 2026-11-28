import { describe, expect, mock, test } from 'bun:test';
import { celebrate, onCelebrate } from './celebrate';

describe('celebrate', () => {
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
