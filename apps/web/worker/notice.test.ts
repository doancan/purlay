/**
 * The push worker's decisions (#78, D-126): what a push is shown as, and where a click goes. Each
 * notice it builds is checked against the contract the server sends, from the other side.
 */
import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { PushOpenMessage, PushPayload } from '@purlay/types';
import { PLAIN_NOTICE, noticeOf, openMessage, optionsOf, pathOf, tabFor } from './notice';

const ORIGIN = 'https://chat.example.com';

const sent: PushPayload = {
  title: 'Alice in #api',
  body: 'mentioned you',
  url: '/w/acme/c/123',
  tag: 'channel:123',
};

describe('a push becomes a notice', () => {
  test('successive notices keep one conversation tag while requesting another alert', () => {
    const first = optionsOf(sent);
    const second = optionsOf({ ...sent, body: 'another direct message' });
    expect(first).toEqual({
      body: sent.body,
      tag: sent.tag,
      icon: '/favicon.svg',
      renotify: true,
      data: { url: sent.url },
    });
    expect(second).toMatchObject({ tag: sent.tag, renotify: true, body: 'another direct message' });
    const fallback = optionsOf(noticeOf(JSON.stringify({ ...sent, tag: '' }), ORIGIN));
    expect(fallback).toMatchObject({ tag: 'purlay', renotify: true });
  });
  test('what the server sent is shown as it was sent', () => {
    const notice = noticeOf(JSON.stringify(sent), ORIGIN);
    expect(notice).toEqual(sent);
    expect(Value.Check(PushPayload, notice)).toBe(true);
  });

  test('a push that cannot be read is still shown, as the plain notice', () => {
    for (const text of [null, '', 'not json', '42', 'null', '[]']) {
      const notice = noticeOf(text, ORIGIN);
      expect({ text, notice }).toEqual({ text, notice: { ...PLAIN_NOTICE } });
      expect(Value.Check(PushPayload, notice)).toBe(true);
    }
  });

  test('a field missing or of the wrong kind falls back alone; the rest is kept', () => {
    expect(noticeOf(JSON.stringify({ ...sent, title: 7, tag: '' }), ORIGIN)).toEqual({
      ...sent,
      title: PLAIN_NOTICE.title,
      tag: PLAIN_NOTICE.tag,
    });
  });
});

describe('a click goes to a path of this site, and nowhere else', () => {
  test.each([
    ['/w/acme/c/1', '/w/acme/c/1'],
    ['/w/acme/c/1?m=2#x', '/w/acme/c/1?m=2#x'],
    ['//evil.example/x', '/'],
    // A URL parser reads a backslash as a slash, and drops a tab or a newline.
    ['/\\evil.example/x', '/'],
    ['/\t/evil.example/x', '/'],
    ['/\n/evil.example/x', '/'],
    ['https://evil.example/', '/'],
    ['javascript:alert(1)', '/'],
    ['w/acme', '/'],
    [undefined, '/'],
  ])('%p opens %p', (given, opened) => {
    expect(pathOf(given, ORIGIN)).toBe(opened);
    expect(noticeOf(JSON.stringify({ ...sent, url: given }), ORIGIN).url).toBe(opened);
  });

  test('a thread target survives the shown notice and the message sent to a tab', () => {
    const url =
      '/w/acme/c/01911111-1111-7111-8111-111111111111?thread=01922222-2222-7222-8222-222222222222';
    const notice = noticeOf(JSON.stringify({ ...sent, url }), ORIGIN);
    expect(Value.Check(PushPayload, notice)).toBe(true);
    const opened = openMessage(pathOf(notice.url, ORIGIN));
    expect(opened).toEqual({ kind: 'push-open', url });
    expect(Value.Check(PushOpenMessage, opened)).toBe(true);
  });

  test('the contract refuses what the worker would not open', () => {
    for (const url of ['//evil.example/x', '/\\evil.example/x', '/\t/evil.example/x', '/\n/x']) {
      expect({ url, accepted: Value.Check(PushPayload, { ...sent, url }) }).toEqual({
        url,
        accepted: false,
      });
      expect(Value.Check(PushOpenMessage, openMessage(url))).toBe(false);
    }
    expect(Value.Check(PushOpenMessage, openMessage('/w/acme/c/1'))).toBe(true);
  });

  test('in the focused tab, else the first one open, else a new one', () => {
    const a = { focused: false, name: 'a' };
    const b = { focused: true, name: 'b' };
    expect(tabFor([a, b])).toBe(b);
    expect(tabFor([a])).toBe(a);
    expect(tabFor<{ focused: boolean }>([])).toBeUndefined();
  });
});
