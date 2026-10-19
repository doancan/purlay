/**
 * A group conversation's face (D-167), where a person meets it: its sidebar row and its header.
 * Two faces, the first two of its people in the order its name is written; "+N" for the rest; the
 * row's height and its unread and muted marks exactly as any other row's.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { erasedPerson, type Channel, type User } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import {
  ALICE,
  BOB,
  IDS,
  aChannel,
  aSignedInApi,
  aUser,
  someChannels,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render';

installDom();

const GROUP = '00000000-0000-4000-8000-0000000000d9';
const CAROL = aUser('carol', '00000000-0000-4000-8000-0000000000f1');
const DAVE = aUser('dave', '00000000-0000-4000-8000-0000000000f2');
const ERIN = aUser('erin', '00000000-0000-4000-8000-0000000000f3');

const aGroup = (peers: readonly User[], over: Partial<Channel> = {}): Channel =>
  aChannel(GROUP, null, {
    type: 'direct_message',
    peers: [...peers],
    lastMessageAt: '2026-09-09T11:00:00.000Z',
    ...over,
  });

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

type View = Awaited<ReturnType<typeof renderApp>>;

interface Where {
  readonly path?: string;
  readonly locale?: 'en' | 'tr';
  readonly api?: Partial<Api>;
}

const open = async (
  group: Channel,
  { path = `/w/acme/c/${IDS.api}`, locale = 'en', api = {} }: Where = {},
): Promise<View> => {
  const view = await renderApp(<Outlet />, {
    path,
    locale,
    api: aSignedInApi({
      channels: () => Promise.resolve([...someChannels(), group]),
      messages: () => Promise.resolve({ data: [], nextCursor: null }),
      ...api,
    }),
  });
  await settle();
  return view;
};

/** The group's row in the sidebar, found by where it goes. */
const rowOf = (view: View): HTMLAnchorElement => {
  const row = view.container.querySelector<HTMLAnchorElement>(`a[href="/w/acme/c/${GROUP}"]`);
  if (row === null) throw new Error('the group has no row');
  return row;
};

const faceIn = (scope: Element): Element => {
  const face = scope.querySelector('[data-group-face]');
  if (face === null) throw new Error('no face drawn');
  return face;
};

const initials = (face: Element): string[] =>
  [...face.querySelectorAll('[data-avatar]')].map((avatar) => avatar.textContent);

const classesOf = (element: Element | null | undefined): string[] =>
  element?.getAttribute('class')?.split(' ') ?? [];

describe('a group’s face in the sidebar', () => {
  test('with two others, is both of them, in the order its name is written, and nothing more', async () => {
    const view = await open(aGroup([BOB, ALICE]));
    const row = rowOf(view);
    const face = faceIn(row);
    expect(initials(face)).toEqual(['B', 'A']);
    expect(face.querySelector('[data-group-more]')).toBeNull();
    expect(row.textContent).toContain('Bob, Alice');
    // The second overlaps the first, cut out of it in the sidebar's own colour.
    const [, second] = face.querySelectorAll('[data-avatar]');
    for (const name of ['-ml-1', 'border-hairline', 'border-nav-surface']) {
      expect(classesOf(second)).toContain(name);
    }
    // Decorative: the name beside it says who is there.
    expect(face.getAttribute('aria-hidden')).toBe('true');
    await expectNoAxeViolations(view.container);
  });

  test('with more than two others, is the first two and how many more', async () => {
    const view = await open(aGroup([ALICE, BOB, CAROL, DAVE, ERIN]));
    const face = faceIn(rowOf(view));
    expect(initials(face)).toEqual(['A', 'B']);
    expect(face.querySelector('[data-group-more]')?.textContent).toBe('+3');
  });

  test('with three, says +1', async () => {
    const view = await open(aGroup([ALICE, BOB, CAROL]));
    expect(faceIn(rowOf(view)).querySelector('[data-group-more]')?.textContent).toBe('+1');
  });

  test('an erased person is a deleted user, in the face and the name, in the reader’s language', async () => {
    const gone = erasedPerson('00000000-0000-4000-8000-0000000000f9');
    const english = await open(aGroup([gone, ALICE]));
    expect(initials(faceIn(rowOf(english)))).toEqual(['D', 'A']);
    expect(rowOf(english).textContent).toContain('Deleted user, Alice');
    english.unmount();

    const turkish = await open(aGroup([gone, ALICE]), { locale: 'tr' });
    expect(initials(faceIn(rowOf(turkish)))).toEqual(['S', 'A']);
    expect(rowOf(turkish).textContent).toContain('Silinmiş kullanıcı, Alice');
  });

  test('keeps the row’s height and its unread and muted marks exactly as any row’s', async () => {
    const view = await open(
      aGroup([ALICE, BOB, CAROL], {
        state: { lastReadMessageId: null, unreadCount: 2, unreadMentionCount: 0 },
        notificationLevel: 'none',
      }),
    );
    const row = rowOf(view);
    const channel = view.container.querySelector(`a[href="/w/acme/c/${IDS.deploys}"]`);
    const height = (classes: string[]): string[] =>
      classes.filter((name) => /(^|:)(h|min-h|py|p)-/u.test(name));
    expect(height(classesOf(row))).toEqual(height(classesOf(channel)));
    expect(height(classesOf(row))).toEqual(['h-row', 'max-narrow:h-touch']);
    // Every piece of the face is one small avatar tall: nothing in it can grow the row.
    for (const piece of faceIn(row).children) {
      expect(classesOf(piece)).toContain('size-avatar-sm');
    }
    expect(classesOf(row)).toContain('font-semibold');
    expect(row.textContent).toContain('unread');
    expect(row.querySelector('[aria-label="muted"]')).not.toBeNull();
  });

  test('on the row you are in, is cut out in the accent', async () => {
    const view = await open(aGroup([ALICE, BOB, CAROL]), { path: `/w/acme/c/${GROUP}` });
    const face = faceIn(rowOf(view));
    for (const piece of [...face.children].slice(1)) {
      expect(classesOf(piece)).toContain('border-accent');
      expect(classesOf(piece)).not.toContain('border-nav-surface');
    }
  });
});

describe('a group’s face in its header', () => {
  test('stands where a channel has its glyph, on the page’s colour', async () => {
    const view = await open(aGroup([ALICE, BOB, CAROL]), { path: `/w/acme/c/${GROUP}` });
    const header = view.container.querySelector('header [data-header-title]');
    if (header === null) throw new Error('no header');
    const face = faceIn(header);
    expect(initials(face)).toEqual(['A', 'B']);
    expect(face.querySelector('[data-group-more]')?.textContent).toBe('+1');
    expect(classesOf(face.querySelector('[data-group-more]'))).toContain('border-surface-100');
    await expectNoAxeViolations(view.container);
  });
});
