/** A username from an address (D-138 §5), a function of its input alone. */
import { describe, expect, test } from 'bun:test';
import { usernameFrom } from './email-sign-in';

describe('a username from an address', () => {
  test('what a mention can name, never a broadcast name, and nothing when nothing is left', () => {
    expect(usernameFrom('ada.lovelace+notes@example.test')).toBe('ada-lovelace-notes');
    expect(usernameFrom('--x__y--@example.test')).toBe('x-y');
    expect(usernameFrom('here@example.test')).toBeNull();
    expect(usernameFrom('everyone@example.test')).toBeNull();
    expect(usernameFrom('...@example.test')).toBeNull();
    expect(usernameFrom(`${'a'.repeat(38)}-b@example.test`)).toBe('a'.repeat(38));
    expect(usernameFrom(`${'a'.repeat(60)}@example.test`)).toHaveLength(39);
  });
});
