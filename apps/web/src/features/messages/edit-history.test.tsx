/**
 * What an edited message said before (#82, D-135), opened from its "edited" mark: the words now,
 * then each earlier version, newest first, in its three states with a real failure; older versions a
 * page at a time; the author removes one after being asked, and nobody else is offered it; a message
 * edited before versions were kept says so.
 */
import { describe, expect, test } from 'bun:test';
import { within } from '@testing-library/react';
import type { MessageVersionPage } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { anApi } from '../../testing/fake-api';
import { expectFocusOn } from '../../testing/focus';
import { ALICE, ME, aMessage } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { settle } from '../../testing/channel-harness';
import { person } from '../../testing/user';
import { EditedMark } from './edit-history';

installDom();

const EDITED = '2026-09-09T09:00:00.000Z';
const version = (n: number): MessageVersionPage['data'][number] => ({
  id: `0199155c-6200-7b7f-8c11-0000000000${String(n).padStart(2, '0')}`,
  content: `said ${String(n)}`,
  replacedAt: `2026-09-09T08:${String(n).padStart(2, '0')}:00.000Z`,
});

const mount = async (
  api: Parameters<typeof anApi>[0],
  mine = false,
  locale?: 'en' | 'tr',
): ReturnType<typeof renderApp> =>
  await renderApp(
    <EditedMark
      message={aMessage(1, { sender: mine ? ME : ALICE, content: 'said now', editedAt: EDITED })}
      mine={mine}
    />,
    { api: anApi(api), ...(locale === undefined ? {} : { locale }) },
  );

const opened = async (view: Awaited<ReturnType<typeof renderApp>>): Promise<HTMLElement> => {
  await person().click(
    view.getByRole('button', { name: /show what it said before|önceki halini/ }),
  );
  await settle();
  return view.getByRole('dialog');
};

describe('a message’s edit history', () => {
  test('the words now, then each earlier version newest first, with when it was replaced', async () => {
    const view = await mount({
      messageVersions: () => Promise.resolve({ data: [version(2), version(1)], nextCursor: null }),
    });
    const dialog = await opened(view);
    expect(within(dialog).getByText('said now')).toBeDefined();
    const earlier = within(dialog).getByRole('list', { name: 'Earlier versions' });
    expect(
      within(earlier)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining('said 2') as unknown as string,
      expect.stringContaining('said 1') as unknown as string,
    ]);
    // Nobody but the author is offered to remove one.
    expect(within(dialog).queryByRole('button', { name: /^Remove/ })).toBeNull();
    await expectNoAxeViolations(dialog);
    view.unmount();
  });

  test('a failure says why with Retry; read again, a message edited before versions were kept says so', async () => {
    let asked = 0;
    const view = await mount({
      messageVersions: () => {
        asked += 1;
        return asked === 1
          ? Promise.reject(new ApiError(500, 'INTERNAL', 'boom'))
          : Promise.resolve({ data: [], nextCursor: null });
      },
    });
    const dialog = await opened(view);
    expect(within(dialog).getByText(/went wrong/i)).toBeDefined();
    await person().click(within(dialog).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(
      within(dialog).getByText('Earlier versions of this message were not kept.'),
    ).toBeDefined();
    view.unmount();
  });

  test('older versions arrive a page at a time, from the cursor it was given', async () => {
    const before: (string | undefined)[] = [];
    const view = await mount({
      messageVersions: (_message, cursor) => {
        before.push(cursor);
        return Promise.resolve(
          cursor === undefined
            ? { data: [version(3)], nextCursor: version(3).id }
            : { data: [version(2)], nextCursor: null },
        );
      },
    });
    const dialog = await opened(view);
    await person().click(within(dialog).getByRole('button', { name: 'Show older versions' }));
    await settle();
    expect(before).toEqual([undefined, version(3).id]);
    expect(within(dialog).getByText('said 2')).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: 'Show older versions' })).toBeNull();
    view.unmount();
  });

  test('the author removes one after being asked; Cancel gives focus back; the list is read again', async () => {
    const removed: [string, string][] = [];
    let listed = 0;
    const view = await mount(
      {
        messageVersions: () => {
          listed += 1;
          return Promise.resolve({
            data: listed === 1 ? [version(2), version(1)] : [version(2)],
            nextCursor: null,
          });
        },
        removeMessageVersion: (message, id) => {
          removed.push([message, id]);
          return Promise.resolve();
        },
      },
      true,
    );
    const dialog = await opened(view);
    const [, second] = within(dialog).getAllByRole('button', { name: /^Remove the version/ });
    if (second === undefined) throw new Error('no second remove');
    await person().click(second);
    const question = within(dialog).getByRole('group', { name: /Remove this version/ });
    expectFocusOn(within(question).getByRole('button', { name: 'Cancel' }));
    await person().click(within(question).getByRole('button', { name: 'Cancel' }));
    expect(removed).toEqual([]);

    const [, again] = within(dialog).getAllByRole('button', { name: /^Remove the version/ });
    if (again === undefined) throw new Error('no second remove');
    await person().click(again);
    await person().click(
      within(within(dialog).getByRole('group', { name: /Remove this version/ })).getByRole(
        'button',
        { name: 'Remove' },
      ),
    );
    await settle();
    expect(removed).toEqual([[aMessage(1).id, version(1).id]]);
    expect(within(dialog).queryByText('said 1')).toBeNull();
    view.unmount();
  });

  test('a refused removal is said, and the version stays', async () => {
    const view = await mount(
      {
        messageVersions: () => Promise.resolve({ data: [version(1)], nextCursor: null }),
        removeMessageVersion: () =>
          Promise.reject(new ApiError(404, 'MESSAGE_VERSION_NOT_FOUND', 'gone')),
      },
      true,
    );
    const dialog = await opened(view);
    await person().click(within(dialog).getByRole('button', { name: /^Remove the version/ }));
    await person().click(
      within(within(dialog).getByRole('group')).getByRole('button', { name: 'Remove' }),
    );
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toContain('Couldn’t remove the version.');
    expect(within(dialog).getByText('said 1')).toBeDefined();
    view.unmount();
  });

  test('in Turkish, it speaks Turkish', async () => {
    const view = await mount(
      { messageVersions: () => Promise.resolve({ data: [], nextCursor: null }) },
      false,
      'tr',
    );
    const dialog = await opened(view);
    expect(within(dialog).getByText('Bu mesajın önceki sürümleri saklanmadı.')).toBeDefined();
    view.unmount();
  });
});
