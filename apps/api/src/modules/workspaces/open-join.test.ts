/**
 * The boot notice says which state the instance is in, in both states (D-37).
 */
import { describe, expect, test } from 'bun:test';
import { openJoinNotice } from './open-join';

describe('the open-join boot notice', () => {
  test('a closed instance says so, rather than saying nothing', () => {
    expect(openJoinNotice(undefined)).toStartWith('open join: off');
    expect(openJoinNotice(undefined)).toContain('WORKSPACE_OPEN_JOIN_SLUG');
  });

  test('an open instance names the workspace and who gets in', () => {
    const notice = openJoinNotice('team');
    expect(notice).toStartWith('open join: ON');
    expect(notice).toContain('"team"');
    expect(notice).toContain('anyone who signs in with GitHub');
  });

  test('it warns that an unclaimed slug belongs to whoever creates it first', () => {
    expect(openJoinNotice('team')).toContain('first creates one with it will own');
  });
});
