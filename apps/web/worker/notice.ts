/**
 * What the push worker decides, as functions of their inputs (#78, D-126): the notice a push
 * becomes, and where a click on it goes. The worker itself only wires these to the browser's events.
 *
 * A push is the server's words, encrypted for this device, but they are still parsed rather than
 * trusted: a payload that cannot be read is shown as the plain notice, because a push that shows
 * nothing is one the browser penalises (D-126 §5), and an address that is not a path of this site
 * is the start page.
 */
import type { PushOpenMessage, PushPayload } from '@purlay/types';

/** What is shown when a push cannot be read. */
export const PLAIN_NOTICE: PushPayload = { title: 'Purlay', body: '', url: '/', tag: 'purlay' };

/**
 * A path of this site, or the start page. Judged by where it resolves, not by how it is spelled:
 * `/\\host`, and a slash after a tab or a newline, are another site's address to a URL parser.
 */
export const pathOf = (value: unknown, origin: string): string => {
  if (typeof value !== 'string' || !value.startsWith('/') || !URL.canParse(value, origin)) {
    return '/';
  }
  const url = new URL(value, origin);
  return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : '/';
};

const textOf = (data: object, name: keyof PushPayload, fallback: string): string => {
  const value: unknown = Reflect.get(data, name);
  return typeof value === 'string' && value.length > 0 ? value : fallback;
};

/** The notice a push's decrypted text becomes. */
export const noticeOf = (text: string | null, origin: string): PushPayload => {
  if (text === null) return PLAIN_NOTICE;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    // Unreadable is an answer — the plain notice — and anything else is not ours to swallow.
    if (error instanceof SyntaxError) return PLAIN_NOTICE;
    throw error;
  }
  if (typeof data !== 'object' || data === null) return PLAIN_NOTICE;
  return {
    title: textOf(data, 'title', PLAIN_NOTICE.title),
    body: textOf(data, 'body', ''),
    url: pathOf(Reflect.get(data, 'url'), origin),
    tag: textOf(data, 'tag', PLAIN_NOTICE.tag),
  };
};

/** A tab of this site, as the worker sees it. */
export interface OpenTab {
  readonly focused: boolean;
}

/** The tab a click is shown in: the focused one, else the first; `undefined` opens a new one. */
export const tabFor = <Tab extends OpenTab>(tabs: readonly Tab[]): Tab | undefined =>
  tabs.find((tab) => tab.focused) ?? tabs[0];

export const openMessage = (url: string): PushOpenMessage => ({ kind: 'push-open', url });
