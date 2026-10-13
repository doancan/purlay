import { describe, expect, test } from 'bun:test';
import { CHANNEL_NAME, CHANNEL_NAME_MAX, finishedChannelName, toChannelName } from './channel-name';

describe('a channel name, as it is typed', () => {
  test.each([
    ['Genel Sohbet', 'genel-sohbet'],
    ['İstanbul Ekibi', 'istanbul-ekibi'],
    ['IŞIK ÇĞÖÜ', 'isik-cgou'],
    ['ırmak', 'irmak'],
    ['Café Crème', 'cafe-creme'],
    ['  front--end  ', 'front-end-'],
    ['#api / web', 'api-web'],
    ['deploys_2026', 'deploys-2026'],
    ['already-fine', 'already-fine'],
  ])('%p becomes %p', (typed, wanted) => {
    expect(toChannelName(typed)).toBe(wanted);
  });

  test('a separator just typed stays, so the next word has somewhere to go', () => {
    expect(toChannelName('genel ')).toBe('genel-');
    expect(toChannelName('genel-s')).toBe('genel-s');
  });

  test('nothing is left of what has no letter or number, and nothing is longer than the contract allows', () => {
    expect(toChannelName('!!!')).toBe('');
    expect(toChannelName('a'.repeat(100))).toHaveLength(CHANNEL_NAME_MAX);
  });

  test('what is sent has no hyphen at its end, and satisfies the rule', () => {
    for (const typed of ['Genel Sohbet ', 'İstanbul—', 'x']) {
      const name = finishedChannelName(typed);
      expect(name.endsWith('-')).toBe(false);
      expect(CHANNEL_NAME.test(name)).toBe(true);
    }
  });
});
