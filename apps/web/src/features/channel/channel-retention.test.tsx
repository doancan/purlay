/**
 * How long a channel keeps its history (D-225), in its details, against the fake API: an owner's alone,
 * in its three states with a real failure; the workspace's window and the channel's said in words; only
 * windows longer than the workspace's offered, with forever and the workspace's own; a longer one saved
 * plainly, by keyboard too; keeping less said in red before it is saved; a refusal for being too short
 * said in words of its own; in Turkish and in the dark theme.
 */
import { describe, expect, test } from 'bun:test';
import { within } from '@testing-library/react';
import type { ChannelRetention, ChannelRetentionFloor, MeResponse, UserRole } from '@purlay/types';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { mountChannel, page, settle, type ChannelView } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { IDS, aSession } from '../../testing/fixtures';
import { person } from '../../testing/user';

installDom();

const as = (role: UserRole): MeResponse => {
  const session = aSession();
  return { ...session, memberships: session.memberships.map((m) => ({ ...m, role })) };
};

const setting = (over: Partial<ChannelRetention> = {}): ChannelRetention => ({
  keepsAtLeast: null,
  workspaceDays: 30,
  effectiveDays: 30,
  ...over,
});

/** The rule the server keeps, for a fake that answers as it would: the longer window wins. */
const answered = (
  workspaceDays: number | null,
  keepsAtLeast: ChannelRetentionFloor,
): ChannelRetention => ({
  keepsAtLeast,
  workspaceDays,
  effectiveDays:
    workspaceDays === null || keepsAtLeast === 'forever'
      ? null
      : keepsAtLeast === null
        ? workspaceDays
        : Math.max(workspaceDays, keepsAtLeast),
});

const mount = async (
  api: Partial<Api>,
  options: {
    readonly role?: UserRole;
    readonly locale?: 'en' | 'tr';
    readonly dark?: boolean;
  } = {},
): Promise<ChannelView> =>
  await mountChannel({
    messages: page([]),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    ...(options.dark === undefined ? {} : { dark: options.dark }),
    api: { me: () => Promise.resolve(as(options.role ?? 'owner')), ...api },
  });

const openDetails = async (view: ChannelView, title = 'Details of #api'): Promise<HTMLElement> => {
  await person().click(view.getByRole('button', { name: 'api' }));
  await settle();
  // The dialog is a chunk of its own (#687): waited for, not assumed.
  const dialog = await view.findByRole('dialog', { name: title });
  await settle();
  return dialog;
};

const sectionOf = (dialog: HTMLElement, name = 'History'): HTMLElement =>
  within(dialog).getByRole('region', { name });

const selectOf = (section: HTMLElement, label = 'Keep this channel’s history'): HTMLSelectElement =>
  within(section).getByLabelText<HTMLSelectElement>(label);

describe('how long a channel keeps its history, as an owner sees it', () => {
  test('while it is read, says so; a failure offers Retry, which reads again', async () => {
    let calls = 0;
    const view = await mount({
      channelRetention: async () => {
        calls += 1;
        if (calls === 1) throw new ApiError(500, 'INTERNAL', 'boom');
        return await Promise.resolve(setting());
      },
    });
    const section = sectionOf(await openDetails(view));
    expect(within(section).getByText(/went wrong/i)).toBeDefined();
    await person().click(within(section).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(selectOf(section).value).toBe('workspace');
    view.unmountAll();

    const pending = await mount({ channelRetention: () => new Promise(() => undefined) });
    expect(within(sectionOf(await openDetails(pending))).getByRole('status')).toBeDefined();
    pending.unmountAll();
  });

  test('says both windows in words, and offers only longer ones, forever, or the workspace’s', async () => {
    const view = await mount({
      channelRetention: () => Promise.resolve(setting({ workspaceDays: 365, effectiveDays: 365 })),
    });
    const section = sectionOf(await openDetails(view));
    expect(section.textContent).toContain('The workspace keeps history for 1 year.');
    expect(section.textContent).toContain('This channel keeps its messages and files for 1 year.');
    expect(
      [...selectOf(section).options].map((option) => [option.value, option.textContent]),
    ).toEqual([
      ['workspace', 'As long as the workspace'],
      ['730', '2 years'],
      ['1825', '5 years'],
      ['forever', 'Forever'],
    ]);
    expect(within(section).getByRole('button', { name: 'Save history setting' })).toHaveProperty(
      'disabled',
      true,
    );
    view.unmountAll();
  });

  test('a floor the workspace has since outgrown is shown as itself, and what is kept is the longer', async () => {
    const view = await mount({
      channelRetention: () =>
        Promise.resolve(setting({ keepsAtLeast: 90, workspaceDays: 365, effectiveDays: 365 })),
    });
    const section = sectionOf(await openDetails(view));
    expect(selectOf(section).value).toBe('90');
    expect(section.textContent).toContain('This channel keeps its messages and files for 1 year.');
    view.unmountAll();
  });

  test('forever deletes nothing: saved plainly from the keyboard, and the screen says it keeps everything', async () => {
    const asked: [string, ChannelRetentionFloor][] = [];
    const view = await mount({
      channelRetention: () => Promise.resolve(setting()),
      setChannelRetention: (channelId, keepsAtLeast) => {
        asked.push([channelId, keepsAtLeast]);
        return Promise.resolve(answered(30, keepsAtLeast));
      },
    });
    const section = sectionOf(await openDetails(view));
    await person().selectOptions(selectOf(section), 'Forever');
    expect(within(section).queryByRole('note')).toBeNull();
    const save = within(section).getByRole('button', { name: 'Save history setting' });
    save.focus();
    await person().keyboard('{Enter}');
    await settle();
    expect(asked).toEqual([[IDS.api, 'forever']]);
    expect(view.getByText('Saved.')).toBeDefined();
    expect(section.textContent).toContain('This channel keeps everything.');
    expect(within(section).getByRole('button', { name: 'Save history setting' })).toHaveProperty(
      'disabled',
      true,
    );
    view.unmountAll();
  });

  test('keeping less than now is said in full, in red, before it is saved', async () => {
    const asked: ChannelRetentionFloor[] = [];
    const view = await mount({
      channelRetention: () =>
        Promise.resolve(setting({ keepsAtLeast: 'forever', effectiveDays: null })),
      setChannelRetention: (_channelId, keepsAtLeast) => {
        asked.push(keepsAtLeast);
        return Promise.resolve(answered(30, keepsAtLeast));
      },
    });
    const dialog = await openDetails(view);
    const section = sectionOf(dialog);
    await person().selectOptions(selectOf(section), 'As long as the workspace');
    expect(within(section).getByRole('note').textContent).toContain(
      'messages and files in this channel older than 30 days will be deleted for good',
    );
    const destroy = within(section).getByRole('button', { name: 'Keep only 30 days' });
    expect(destroy.className).toContain('bg-danger');
    await expectNoAxeViolations(dialog);
    await person().click(destroy);
    await settle();
    expect(asked).toEqual([null]);
    expect(within(section).queryByRole('note')).toBeNull();
    view.unmountAll();
  });

  test('refused for being shorter than the workspace now keeps: said in words, and read again', async () => {
    let reads = 0;
    const view = await mount({
      channelRetention: () => {
        reads += 1;
        return Promise.resolve(
          reads === 1 ? setting() : setting({ workspaceDays: 1825, effectiveDays: 1825 }),
        );
      },
      setChannelRetention: () =>
        Promise.reject(new ApiError(409, 'RETENTION_TOO_SHORT', 'too short')),
    });
    const section = sectionOf(await openDetails(view));
    await person().selectOptions(selectOf(section), '1 year');
    await person().click(within(section).getByRole('button', { name: 'Save history setting' }));
    await settle();
    expect(within(section).getByRole('alert').textContent).toBe(
      'The workspace now keeps history at least that long. Choose a longer window, or forever.',
    );
    expect(reads).toBe(2);
    expect(section.textContent).toContain('The workspace keeps history for 5 years.');
    view.unmountAll();
  });

  test('any other refusal is said with what went wrong, and the choice stays — in Turkish, in the dark', async () => {
    const view = await mount(
      {
        channelRetention: () =>
          Promise.resolve(setting({ workspaceDays: null, effectiveDays: null })),
        setChannelRetention: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'no')),
      },
      { locale: 'tr', dark: true },
    );
    const dialog = await openDetails(view, '#api ayrıntıları');
    const section = sectionOf(dialog, 'Geçmiş');
    expect(section.textContent).toContain('Çalışma alanı her şeyi saklıyor.');
    const select = selectOf(section, 'Bu kanalın geçmişini sakla');
    // Nothing is longer than forever but forever itself.
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Çalışma alanı kadar',
      'Süresiz',
    ]);
    await person().selectOptions(select, 'Süresiz');
    await person().click(within(section).getByRole('button', { name: 'Geçmiş ayarını kaydet' }));
    await settle();
    expect(within(section).getByRole('alert').textContent).toContain('Ayar kaydedilmedi.');
    expect(select.value).toBe('forever');
    await expectNoAxeViolations(dialog);
    view.unmountAll();
  });
});

describe('as an admin or a member', () => {
  test('there is no history section, and nothing is asked for', async () => {
    for (const role of ['admin', 'member'] as const) {
      let asked = 0;
      const view = await mount(
        {
          channelRetention: () => {
            asked += 1;
            return Promise.resolve(setting());
          },
        },
        { role },
      );
      const dialog = await openDetails(view);
      expect({ role, section: within(dialog).queryByRole('region', { name: 'History' }) }).toEqual({
        role,
        section: null,
      });
      expect(asked).toBe(0);
      view.unmountAll();
    }
  });
});
