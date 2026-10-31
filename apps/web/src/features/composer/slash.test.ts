/** Slash commands' pure half (D-214): what a line asks for, what is being typed, what is written. */
import { describe, expect, test } from 'bun:test';
import { installDom } from '../../testing/dom';
import {
  commandsFor,
  deepWorkOf,
  inviteeOf,
  meMessage,
  parseSlash,
  shrugMessage,
  slashQuery,
} from './slash';

installDom();

describe('a line that starts with a slash', () => {
  test('is a command and its words, an unknown one, or escaped with //', () => {
    expect(parseSlash('/topic Deploys and incidents')).toEqual({
      kind: 'command',
      name: 'topic',
      args: 'Deploys and incidents',
    });
    expect(parseSlash('/MUTE')).toEqual({ kind: 'command', name: 'mute', args: '' });
    expect(parseSlash('/deploy now')).toEqual({ kind: 'unknown', name: 'deploy' });
    expect(parseSlash('//etc/hosts is the file')).toEqual({
      kind: 'escaped',
      text: '/etc/hosts is the file',
    });
  });

  test('a path or words are not a command', () => {
    expect(parseSlash('/usr/local/bin')).toBeNull();
    expect(parseSlash('see /topic')).toBeNull();
    expect(parseSlash('')).toBeNull();
  });

  test('the command being typed is the letters after a / at the very start, up to the caret', () => {
    expect(slashQuery('/to', 3)).toBe('to');
    expect(slashQuery('/', 1)).toBe('');
    expect(slashQuery('/topic x', 8)).toBeNull();
    expect(slashQuery('a /to', 5)).toBeNull();
    expect(commandsFor('s')).toEqual(['shrug', 'star', 'search']);
    expect(commandsFor('zz')).toEqual([]);
  });
});

describe('what a command writes', () => {
  test('/me is the words in italics, its underscores kept as underscores', () => {
    expect(meMessage('waves at snake_case')).toBe('_waves at snake\\_case_');
    expect(meMessage('')).toBeNull();
  });

  test('/me ending in a backslash still ends its italics', () => {
    expect(meMessage('looks at C:\\')).toBe('_looks at C:\\\\_');
  });

  test('/shrug keeps its arm: the backslash and underscores are not markdown', () => {
    expect(shrugMessage('')).toBe('¯\\\\\\_(ツ)\\_/¯');
    expect(shrugMessage('oh well')).toBe('oh well ¯\\\\\\_(ツ)\\_/¯');
  });

  test('/deepwork knows its whiles, off, and an hour by default', () => {
    expect(deepWorkOf('2h')).toBe('2h');
    expect(deepWorkOf('')).toBe('1h');
    expect(deepWorkOf('OFF')).toBe('off');
    expect(deepWorkOf('3 days')).toBeNull();
  });

  test('/invite takes one handle, with or without its @, Unicode included', () => {
    // Lower-cased as the members are compared: the same on both sides, whatever the letter.
    expect(inviteeOf('@Işıl')).toBe('Işıl'.toLowerCase());
    expect(inviteeOf('alice')).toBe('alice');
    expect(inviteeOf('alice bob')).toBeNull();
    expect(inviteeOf('')).toBeNull();
  });
});
