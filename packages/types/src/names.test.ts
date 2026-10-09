/**
 * What a name may contain.
 *
 * Found by attack: `{"name":"a\u0000b"}` on `POST /api/workspaces` was a 500 and an
 * error report, because PostgreSQL cannot store a NUL and nothing at the contract
 * said so. Message content already refused it; names did not.
 */
import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { CreateChannelRequest, CreateWorkspaceRequest } from './api';

const workspace = (name: string): boolean =>
  Value.Check(CreateWorkspaceRequest, { name, slug: 'acme' });
const channel = (name: string): boolean => Value.Check(CreateChannelRequest, { name });

const cases: readonly [string, string][] = [
  ['NUL', 'a\u0000b'],
  ['a C0 control', 'a\u0007b'],
  ['a tab', 'a\tb'],
  ['a line feed', 'a\nb'],
  ['a carriage return', 'a\rb'],
  ['escape', 'a\u001Bb'],
  ['DEL', 'a\u007Fb'],
  ['a C1 control', 'a\u0085b'],
  ['a line separator', 'a b'],
  ['a paragraph separator', 'a b'],
  ['a right-to-left override', 'gpj‮exe.txt'],
  ['a left-to-right embedding', 'a‪b'],
  ['a pop directional formatting', 'a‬b'],
  ['a right-to-left isolate', 'a⁧b'],
  ['a pop directional isolate', 'a⁩b'],
  ['a lone high surrogate', 'a\uD800b'],
  ['a lone low surrogate', 'a\uDC00b'],
];

describe('workspace and channel names', () => {
  for (const [what, name] of cases) {
    test(`${what} is refused in a workspace name and in a channel name`, () => {
      expect(workspace(name)).toBe(false);
      expect(channel(name)).toBe(false);
    });
  }

  test('ordinary names, including other scripts and emoji, are accepted', () => {
    for (const name of [
      'general',
      'Acme Corp',
      'günlük',
      '开发',
      'عربى',
      'שלום',
      'build 🚀',
      "o'neil",
    ]) {
      expect({ name, workspace: workspace(name), channel: channel(name) }).toEqual({
        name,
        workspace: true,
        channel: true,
      });
    }
  });

  test('a channel topic may not hold what PostgreSQL cannot store', () => {
    expect(Value.Check(CreateChannelRequest, { name: 'ok', topic: 'a\u0000b' })).toBe(false);
    expect(Value.Check(CreateChannelRequest, { name: 'ok', topic: 'a\uD800b' })).toBe(false);
    expect(Value.Check(CreateChannelRequest, { name: 'ok', topic: 'line one\nline two' })).toBe(
      true,
    );
  });

  test('a slug could never hold any of them: its pattern is a whitelist', () => {
    for (const [, value] of cases) {
      expect(Value.Check(CreateWorkspaceRequest, { name: 'ok', slug: `a${value}b` })).toBe(false);
    }
  });
});
