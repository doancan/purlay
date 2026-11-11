/**
 * What a message carries, drawn under its words (D-109 §6, #369): an image as its thumbnail in space
 * kept for it before it loads, opening the full image; a file as its name, its size and a download;
 * nothing at all on a tombstone. A thumbnail that does not load says so, with Retry.
 */
import { describe, expect, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import type { Attachment, MeResponse } from '@purlay/types';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { ME, IDS, aMessage, aSession } from '../../../testing/fixtures';
import { anApi } from '../../../testing/fake-api';
import { workspaceAccessChanged } from '../../../data/access-change';
import { useMe } from '../../../data/queries';
import { keys } from '../../../data/keys';
import { renderApp } from '../../../testing/render';
import { MessageRow, type MessageRowProps } from './message-row';

installDom();

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);

const IMAGE: Attachment = {
  id: '01995f7b-0000-7000-8000-000000000001',
  fileName: 'Ekran görüntüsü.png',
  mimeType: 'image/webp',
  sizeBytes: 48_000,
  kind: 'image',
  width: 1600,
  height: 900,
};

const FILE: Attachment = {
  id: '01995f7b-0000-7000-8000-000000000002',
  fileName: 'notes.pdf',
  mimeType: 'application/octet-stream',
  sizeBytes: 1536,
  kind: 'file',
  width: null,
  height: null,
};

const row = (over: Parameters<typeof aMessage>[1] = {}): MessageRowProps => ({
  message: aMessage(1, { createdAt: '2026-09-09T11:55:00.000Z', ...over }),
  meId: ME.id,
  nowMinute: NOW,
  members: new Map([[ME.id, 'dogancan']]),
});

describe('a message’s attachments', () => {
  test('an uncertain preview still readable elsewhere rebinds after the lost-workspace receipt, without refetching under old access', async () => {
    const initial = aSession();
    const base = initial.memberships[0];
    if (base === undefined) throw new Error('Missing workspace fixture');
    const other = {
      ...base,
      workspace: {
        ...base.workspace,
        id: '00000000-0000-4000-8000-0000000000bb',
        slug: 'other',
        name: 'Other',
      },
    };
    initial.memberships = [base, other];
    let served = initial;
    let cachedMemberships = (): number => -1;
    const counts: number[] = [];
    const Probe = (): React.JSX.Element => {
      const me = useMe().data;
      return <p>{`Memberships ${String(me?.memberships.length ?? 0)}`}</p>;
    };
    const view = await renderApp(
      <>
        <Probe />
        <MessageRow
          {...row({
            channelId: '00000000-0000-4000-8000-0000000000cc',
            attachments: [{ ...FILE, fileName: 'other.txt', mimeType: 'text/plain' }],
          })}
        />
      </>,
      {
        api: anApi({
          me: () => Promise.resolve(served),
          attachmentText: () => {
            counts.push(cachedMemberships());
            return Promise.resolve('Other workspace readable file');
          },
        }),
      },
    );
    cachedMemberships = (): number =>
      view.world.client.getQueryData<MeResponse>(keys.me)?.memberships.length ?? 0;
    try {
      await view.findByText('Memberships 2');
      act(() => {
        fireEvent.click(view.getByRole('button', { name: /^Preview/ }));
      });
      await view.findByText('Other workspace readable file');
      served = { ...initial, memberships: [other] };
      await act(async () => {
        await view.world.client.invalidateQueries({ queryKey: keys.me, exact: true });
      });
      await view.findByText('Memberships 1');
      await view.findByText('Other workspace readable file');
      expect(counts).toEqual([2, 1]);
    } finally {
      view.unmount();
      view.world.client.clear();
    }
  });

  test('an open text preview forgets prior access while a fresh read waits and fails', async () => {
    const fresh = Promise.withResolvers<string>();
    let calls = 0;
    const view = await renderApp(
      <MessageRow
        {...row({ attachments: [{ ...FILE, fileName: 'notes.txt', mimeType: 'text/plain' }] })}
      />,
      {
        api: anApi({
          attachmentText: (): Promise<string> => {
            calls++;
            return calls === 1 ? Promise.resolve('Private previous admission') : fresh.promise;
          },
        }),
      },
    );
    try {
      act(() => {
        fireEvent.click(view.getByRole('button', { name: /^Preview/ }));
      });
      await view.findByText('Private previous admission');
      await act(async () => {
        workspaceAccessChanged(view.world.client, IDS.workspace);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      });
      expect(calls).toBe(2);
      expect(view.container.textContent.includes('Private previous admission')).toBe(false);
      await act(async () => {
        fresh.reject(new Error('Fresh preview unavailable'));
        await Promise.resolve();
      });
      await view.findByRole('button', { name: 'Retry' });
      expect(view.container.textContent.includes('Private previous admission')).toBe(false);
    } finally {
      fresh.resolve('late');
      view.unmount();
      view.world.client.clear();
    }
  });

  test('an image is its thumbnail, in its own shape, opening the full image; a file is a download', async () => {
    const view = await renderApp(<MessageRow {...row({ attachments: [IMAGE, FILE] })} />);
    const thumbnail = view.getByRole('img', { name: 'Ekran görüntüsü.png' });
    expect(thumbnail.getAttribute('src')).toBe(`/api/attachments/${IMAGE.id}/thumbnail`);
    // Its space is kept before it loads: the shape is the image's own.
    expect(thumbnail.getAttribute('style')).toContain('aspect-ratio: 1600 / 900');
    expect(thumbnail.closest('a')?.getAttribute('href')).toBe(`/api/attachments/${IMAGE.id}`);

    const download = view.getByRole('link', { name: /notes\.pdf/ });
    expect(download.getAttribute('href')).toBe(`/api/attachments/${FILE.id}`);
    expect(download.hasAttribute('download')).toBe(true);
    expect(download.textContent).toContain('1.5 kB');
    await expectNoAxeViolations(view.container);
  });

  test('in Turkish, the size and the words are Turkish', async () => {
    const view = await renderApp(<MessageRow {...row({ attachments: [FILE] })} />, {
      locale: 'tr',
    });
    const download = view.getByRole('link', { name: /notes\.pdf/ });
    expect(download.textContent).toContain('1,5 kB');
    expect(download.getAttribute('aria-label')).toContain('İndir');
  });

  test('a thumbnail that does not load says so, and Retry asks for it again', async () => {
    const view = await renderApp(<MessageRow {...row({ attachments: [IMAGE] })} />);
    act(() => {
      fireEvent.error(view.getByRole('img', { name: 'Ekran görüntüsü.png' }));
    });
    expect(view.queryByRole('img', { name: 'Ekran görüntüsü.png' })).toBeNull();
    expect(view.getByText('The image did not load.')).toBeDefined();
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    });
    expect(view.getByRole('img', { name: 'Ekran görüntüsü.png' })).toBeDefined();
    await expectNoAxeViolations(view.container);
  });

  test('a deleted message draws none of them, though the cache may still hold them', async () => {
    const view = await renderApp(
      <MessageRow
        {...row({ attachments: [IMAGE, FILE], deletedAt: '2026-09-09T11:58:00.000Z' })}
      />,
    );
    expect(view.queryByRole('img')).toBeNull();
    expect(view.queryByRole('link', { name: /notes\.pdf/ })).toBeNull();
  });

  test('a message without any draws no list', async () => {
    const view = await renderApp(<MessageRow {...row()} />);
    expect(view.queryByRole('list', { name: 'Attachments' })).toBeNull();
  });
});
