/**
 * A channel's incident as a person meets it (#487, D-137): the banner under the header while one is
 * open, the panel in each of its states with a real failure, declaring at a severity with its id kept
 * for a retry, a change painted at once and put back when refused, Resolve asked first, the timeline
 * in words, the sidebar's mark, a visitor who reads and is offered nothing, and Turkish.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type {
  ChangeIncidentRequest,
  DeclareIncidentRequest,
  Incident,
  IncidentUpdatePage,
} from '@purlay/types';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { mountChannel, page, settle, type ChannelView } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { expectFocusOn } from '../../testing/focus';
import { ALICE, BOB, IDS, ME, aChannel, someChannels } from '../../testing/fixtures';
import { person } from '../../testing/user';

installDom();

const DECLARED = '2026-09-09T11:00:00.000Z';
const ID = '0199155c-6200-7b7f-8c11-0000000000f1';

const open = (over: Partial<Incident> = {}): Incident =>
  ({
    id: ID,
    channelId: IDS.api,
    severity: 2,
    status: 'investigating',
    declaredBy: ALICE,
    declaredAt: DECLARED,
    responders: [],
    runbookUrl: null,
    postmortem: '',
    postmortemVersion: 0,
    resolvedAt: null,
    ...over,
  }) as Incident;

const timeline = (): Promise<IncidentUpdatePage> =>
  Promise.resolve({
    data: [
      {
        id: '0199155c-6200-7b7f-8c11-0000000000f3',
        at: '2026-09-09T11:05:00.000Z',
        actor: ME,
        change: { kind: 'severity', from: 2, to: 1 },
      },
      {
        id: '0199155c-6200-7b7f-8c11-0000000000f2',
        at: DECLARED,
        actor: ALICE,
        change: { kind: 'declared', severity: 2 },
      },
    ],
    nextCursor: null,
  });

const mount = async (
  api: Partial<Api>,
  options: { readonly member?: boolean; readonly locale?: 'en' | 'tr' } = {},
): Promise<ChannelView> => {
  const channels = someChannels().map((channel) =>
    channel.id === IDS.api && options.member === false ? { ...channel, state: null } : channel,
  );
  return await mountChannel({
    channelId: IDS.api,
    channels,
    members: [{ user: ME }, { user: ALICE }],
    messages: page([]),
    api: {
      incidentUpdates: timeline,
      channelMembers: () =>
        Promise.resolve([ME, ALICE].map((user) => ({ user, joinedAt: DECLARED }))),
      ...api,
    },
    ...(options.locale === undefined ? {} : { locale: options.locale }),
  });
};

const openPanel = async (view: ChannelView): Promise<HTMLElement> => {
  await person().click(view.getByRole('button', { name: /^Incident$|^Olay$/ }));
  await settle();
  return view.getByRole('complementary', { name: /Incident|Olay/ });
};

describe('a channel’s incident', () => {
  test('open, it is a banner under the header — severity, status, since when — that opens its panel', async () => {
    const view = await mount({ incident: () => Promise.resolve({ incident: open() }) });
    const banner = view.getByRole('region', { name: 'Incident in progress' });
    expect(banner.textContent).toContain('SEV2');
    expect(banner.textContent).toContain('Investigating');
    await person().click(within(banner).getByRole('button', { name: 'Details' }));
    await settle();
    const panel = view.getByRole('complementary', { name: /Incident/ });
    expect(within(panel).getByText('Alice declared it at SEV2')).toBeDefined();
    expect(within(panel).getByText('Dogancan raised it from SEV2 to SEV1')).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmountAll();
  });

  test('none open, there is no banner; the panel says so and declares one, keeping its id for a retry', async () => {
    const asked: DeclareIncidentRequest[] = [];
    let attempt = 0;
    const view = await mount({
      incident: () => Promise.resolve({ incident: null }),
      declareIncident: (_channel, input) => {
        asked.push(input);
        attempt += 1;
        return attempt === 1
          ? Promise.reject(new ApiError(500, 'INTERNAL', 'boom'))
          : Promise.resolve(open({ id: input.id, severity: input.severity }));
      },
    });
    expect(view.queryByRole('region', { name: 'Incident in progress' })).toBeNull();
    const panel = await openPanel(view);
    expect(within(panel).getByText('No incident')).toBeDefined();
    await person().click(within(panel).getByRole('button', { name: 'Severity 1' }));
    await person().click(within(panel).getByRole('button', { name: 'Declare an incident' }));
    await settle();
    // Refused: said, nothing declared, and focus back on the button to try again.
    expect(view.getByText(/went wrong/i)).toBeDefined();
    expectFocusOn(within(panel).getByRole('button', { name: 'Declare an incident' }));
    expect(view.queryByRole('region', { name: 'Incident in progress' })).toBeNull();
    await person().click(within(panel).getByRole('button', { name: 'Declare an incident' }));
    await settle();
    expect(asked.map((input) => input.severity)).toEqual([1, 1]);
    // The same declaration both times: the server answers a retry with what it made (D-137 §5).
    expect(asked[1]?.id).toBe(asked[0]?.id);
    expect(view.getByRole('region', { name: 'Incident in progress' }).textContent).toContain(
      'SEV1',
    );
    // The form went with the declaration: focus is on the panel's heading, where Esc still reaches.
    expectFocusOn(within(panel).getByRole('heading', { level: 2 }));
    view.unmountAll();
  });

  test('a change paints at once, and is put back when refused', async () => {
    let answer: (incident: Incident) => void = () => undefined;
    let refuse: (error: unknown) => void = () => undefined;
    const changes: ChangeIncidentRequest[] = [];
    const view = await mount({
      incident: () => Promise.resolve({ incident: open() }),
      changeIncident: (_channel, _id, input) => {
        changes.push(input);
        return new Promise((resolve, reject) => {
          answer = resolve;
          refuse = reject;
        });
      },
    });
    const panel = await openPanel(view);
    await person().click(within(panel).getByRole('button', { name: 'Mitigating' }));
    // Before the server answers.
    expect(
      within(panel).getByRole('button', { name: 'Mitigating' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(view.getByRole('region', { name: 'Incident in progress' }).textContent).toContain(
      'Mitigating',
    );
    act(() => {
      answer(open({ status: 'mitigating' }));
    });
    await settle();
    await person().click(within(panel).getByRole('button', { name: 'Severity 1' }));
    act(() => {
      refuse(new ApiError(409, 'INCIDENT_RESOLVED', 'resolved'));
    });
    await settle();
    expect(changes).toEqual([{ status: 'mitigating' }, { severity: 1 }]);
    // Put back as it was: SEV2, not the SEV1 that was refused.
    expect(
      within(panel).getByRole('button', { name: 'Severity 2' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      view.getByText('This incident is resolved. Declare a new one if it is back.'),
    ).toBeDefined();
    view.unmountAll();
  });

  test('Resolve asks first; Cancel gives focus back; resolved, the banner goes', async () => {
    const changes: ChangeIncidentRequest[] = [];
    const view = await mount({
      incident: () => Promise.resolve({ incident: open() }),
      changeIncident: (_channel, _id, input) => {
        changes.push(input);
        return Promise.resolve(
          open({ status: 'resolved', resolvedAt: '2026-09-09T12:00:00.000Z' }),
        );
      },
    });
    const panel = await openPanel(view);
    await person().click(within(panel).getByRole('button', { name: 'Resolve…' }));
    const question = within(panel).getByRole('group', { name: /Resolve this incident/ });
    expectFocusOn(within(question).getByRole('button', { name: 'Cancel' }));
    await person().click(within(question).getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(changes).toEqual([]);
    expectFocusOn(within(panel).getByRole('button', { name: 'Resolve…' }));
    await person().click(within(panel).getByRole('button', { name: 'Resolve…' }));
    await person().click(within(panel).getByRole('button', { name: 'Resolve' }));
    await settle();
    expect(changes).toEqual([{ status: 'resolved' }]);
    expect(view.queryByRole('region', { name: 'Incident in progress' })).toBeNull();
    expect(within(panel).getByText('No incident')).toBeDefined();
    view.unmountAll();
  });

  test('the panel loads, fails with a real failure and Retry, and recovers', async () => {
    let failing = true;
    const view = await mount({
      incident: () =>
        failing
          ? Promise.reject(new ApiError(500, 'INTERNAL', 'boom'))
          : Promise.resolve({ incident: null }),
    });
    const panel = await openPanel(view);
    expect(within(panel).getByText('The incident did not load.')).toBeDefined();
    failing = false;
    await person().click(within(panel).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(within(panel).getByText('No incident')).toBeDefined();
    view.unmountAll();
  });

  test('somebody who sees the channel without being in it reads the incident and is offered nothing', async () => {
    const view = await mount(
      { incident: () => Promise.resolve({ incident: open() }) },
      { member: false },
    );
    const panel = await openPanel(view);
    expect(within(panel).queryByRole('button', { name: 'Mitigating' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Resolve…' })).toBeNull();
    expect(within(panel).getByText('Alice declared it at SEV2')).toBeDefined();
    view.unmountAll();
  });

  test('a frame reads it again: declared elsewhere, the banner appears', async () => {
    let current: Incident | null = null;
    const view = await mount({ incident: () => Promise.resolve({ incident: current }) });
    expect(view.queryByRole('region', { name: 'Incident in progress' })).toBeNull();
    current = open({ severity: 3 });
    await act(async () => {
      view.world.sockets.open();
      view.world.sockets.deliver({
        event: 'INCIDENT_UPDATED',
        data: { channelId: IDS.api },
        ts: 0,
      });
      await Promise.resolve();
    });
    await settle();
    expect(view.getByRole('region', { name: 'Incident in progress' }).textContent).toContain(
      'SEV3',
    );
    view.unmountAll();
  });

  test('declared, resolved and declared again: a new declaration, never the old id', async () => {
    const asked: DeclareIncidentRequest[] = [];
    let current: Incident | null = null;
    const view = await mount({
      incident: () => Promise.resolve({ incident: current }),
      declareIncident: (_channel, input) => {
        asked.push(input);
        current = open({ id: input.id, severity: input.severity });
        return Promise.resolve(current);
      },
      changeIncident: () => {
        current = open({
          id: asked.at(-1)?.id ?? ID,
          status: 'resolved',
          resolvedAt: '2026-09-09T12:00:00.000Z',
        });
        return Promise.resolve(current);
      },
    });
    const panel = await openPanel(view);
    await person().click(within(panel).getByRole('button', { name: 'Declare an incident' }));
    await settle();
    await person().click(within(panel).getByRole('button', { name: 'Resolve…' }));
    await person().click(within(panel).getByRole('button', { name: 'Resolve' }));
    await settle();
    // The resolved one is said, with when.
    expect(within(panel).getByText(/The last incident here was resolved/)).toBeDefined();
    await person().click(within(panel).getByRole('button', { name: 'Declare an incident' }));
    await settle();
    expect(asked).toHaveLength(2);
    expect(asked[1]?.id).not.toBe(asked[0]?.id);
    view.unmountAll();
  });

  test('another severity after a failure is another declaration, with its own id', async () => {
    const asked: DeclareIncidentRequest[] = [];
    const view = await mount({
      incident: () => Promise.resolve({ incident: null }),
      declareIncident: (_channel, input) => {
        asked.push(input);
        return Promise.reject(new ApiError(500, 'INTERNAL', 'boom'));
      },
    });
    const panel = await openPanel(view);
    await person().click(within(panel).getByRole('button', { name: 'Declare an incident' }));
    await settle();
    await person().click(within(panel).getByRole('button', { name: 'Severity 3' }));
    await person().click(within(panel).getByRole('button', { name: 'Declare an incident' }));
    await settle();
    expect(asked.map((input) => input.severity)).toEqual([2, 3]);
    expect(asked[1]?.id).not.toBe(asked[0]?.id);
    view.unmountAll();
  });

  test('declared by somebody else at the same moment: said, and theirs is shown', async () => {
    let current: Incident | null = null;
    const view = await mount({
      incident: () => Promise.resolve({ incident: current }),
      declareIncident: () => {
        current = open({ severity: 4, declaredBy: ALICE });
        return Promise.reject(new ApiError(409, 'INCIDENT_OPEN', 'open'));
      },
    });
    const panel = await openPanel(view);
    await person().click(within(panel).getByRole('button', { name: 'Declare an incident' }));
    await settle();
    expect(
      view.getByText(
        'This channel already has an incident open. Change that one, or resolve it first.',
      ),
    ).toBeDefined();
    expect(view.getByRole('region', { name: 'Incident in progress' }).textContent).toContain(
      'SEV4',
    );
    view.unmountAll();
  });

  test('the timeline fails with Retry, pages older entries, and says Someone for a person gone', async () => {
    let failing = true;
    const before: (string | undefined)[] = [];
    const view = await mount({
      incident: () => Promise.resolve({ incident: open() }),
      incidentUpdates: (_channel, _id, cursor) => {
        before.push(cursor);
        if (failing) return Promise.reject(new ApiError(500, 'INTERNAL', 'boom'));
        return Promise.resolve(
          cursor === undefined
            ? {
                data: [
                  {
                    id: '0199155c-6200-7b7f-8c11-0000000000f3',
                    at: '2026-09-09T11:05:00.000Z',
                    actor: null,
                    change: { kind: 'status', from: 'investigating', to: 'mitigating' },
                  },
                ],
                nextCursor: '0199155c-6200-7b7f-8c11-0000000000f3',
              }
            : {
                data: [
                  {
                    id: '0199155c-6200-7b7f-8c11-0000000000f2',
                    at: DECLARED,
                    actor: ALICE,
                    change: { kind: 'declared', severity: 2 },
                  },
                ],
                nextCursor: null,
              },
        );
      },
    });
    const panel = await openPanel(view);
    expect(within(panel).getByRole('alert').textContent).toContain('The timeline did not load.');
    // The controls still work while the timeline does not.
    expect(within(panel).getByRole('button', { name: 'Mitigating' })).toBeDefined();
    await expectNoAxeViolations(panel);
    failing = false;
    await person().click(within(panel).getByRole('button', { name: 'Retry reading the timeline' }));
    await settle();
    expect(within(panel).getByText('Someone moved it to Mitigating')).toBeDefined();
    await person().click(within(panel).getByRole('button', { name: 'Show older' }));
    await settle();
    expect(within(panel).getByText('Alice declared it at SEV2')).toBeDefined();
    expect(before.at(-1)).toBe('0199155c-6200-7b7f-8c11-0000000000f3');
    expect(within(panel).queryByRole('button', { name: 'Show older' })).toBeNull();
    view.unmountAll();
  });

  test('loading says so in the panel; the declare form passes the audit', async () => {
    let answer: (response: { incident: Incident | null }) => void = () => undefined;
    const view = await mount({
      incident: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    const panel = await openPanel(view);
    expect(within(panel).getByRole('status').textContent).toContain('Loading the incident');
    act(() => {
      answer({ incident: null });
    });
    await settle();
    expect(within(panel).getByRole('group', { name: 'Severity' })).toBeDefined();
    await expectNoAxeViolations(panel);
    view.unmountAll();
  });

  test('a visitor with none open is offered no declaration', async () => {
    const view = await mount(
      { incident: () => Promise.resolve({ incident: null }) },
      { member: false },
    );
    const panel = await openPanel(view);
    expect(within(panel).getByText('No incident')).toBeDefined();
    expect(within(panel).queryByRole('button', { name: 'Declare an incident' })).toBeNull();
    expect(within(panel).queryByRole('group', { name: 'Severity' })).toBeNull();
    view.unmountAll();
  });

  test('Details opens the panel and, pressed again, closes it and keeps focus on itself', async () => {
    const view = await mount({ incident: () => Promise.resolve({ incident: open() }) });
    const details = within(view.getByRole('region', { name: 'Incident in progress' })).getByRole(
      'button',
      { name: 'Details' },
    );
    await person().click(details);
    await settle();
    expect(details.getAttribute('aria-pressed')).toBe('true');
    await person().keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('complementary', { name: /Incident/ })).toBeNull();
    expect(details.getAttribute('aria-pressed')).toBe('false');
    view.unmountAll();
  });

  test('two changes at once, both refused: back to what the server said, never to a refused paint', async () => {
    const refusals: ((error: unknown) => void)[] = [];
    let reads = 0;
    const view = await mount({
      incident: () => {
        reads += 1;
        // The read after a refusal fails too: what is shown is the change's own putting back.
        return reads === 1
          ? Promise.resolve({ incident: open() })
          : Promise.reject(new ApiError(500, 'INTERNAL', 'boom'));
      },
      changeIncident: () =>
        new Promise((_resolve, reject) => {
          refusals.push(reject);
        }),
    });
    const panel = await openPanel(view);
    await person().click(within(panel).getByRole('button', { name: 'Severity 1' }));
    await person().click(within(panel).getByRole('button', { name: 'Mitigating' }));
    const pressed = (name: string): string | null =>
      within(panel).getByRole('button', { name }).getAttribute('aria-pressed');
    expect([pressed('Severity 1'), pressed('Mitigating')]).toEqual(['true', 'true']);
    act(() => {
      refusals[0]?.(new ApiError(500, 'INTERNAL', 'first'));
    });
    await settle();
    act(() => {
      refusals[1]?.(new ApiError(500, 'INTERNAL', 'second'));
    });
    await settle();
    expect([pressed('Severity 2'), pressed('Investigating')]).toEqual(['true', 'true']);
    // The read that failed is said above what is kept.
    expect(within(panel).getByText('The incident could not be brought up to date.')).toBeDefined();
    view.unmountAll();
  });

  test('resolved by somebody else under the person’s hands: focus goes to the heading, never nowhere', async () => {
    let current: Incident = open();
    const view = await mount({ incident: () => Promise.resolve({ incident: current }) });
    const panel = await openPanel(view);
    within(panel).getByRole('button', { name: 'Mitigating' }).focus();
    current = open({ status: 'resolved', resolvedAt: '2026-09-09T12:00:00.000Z' });
    await act(async () => {
      view.world.sockets.open();
      view.world.sockets.deliver({
        event: 'INCIDENT_UPDATED',
        data: { channelId: IDS.api },
        ts: 0,
      });
      await Promise.resolve();
    });
    await settle();
    expect(within(panel).queryByRole('button', { name: 'Mitigating' })).toBeNull();
    expectFocusOn(within(panel).getByRole('heading', { level: 2 }));
    view.unmountAll();
  });

  test('a declaration whose answer was lost but which landed is not sent again once it is resolved', async () => {
    const asked: DeclareIncidentRequest[] = [];
    let current: Incident | null = null;
    const view = await mount({
      incident: () => Promise.resolve({ incident: current }),
      declareIncident: (_channel, input) => {
        asked.push(input);
        if (asked.length === 1) {
          // It landed; the answer did not.
          current = open({ id: input.id, severity: input.severity });
          return Promise.reject(new ApiError(503, 'DATABASE_UNAVAILABLE', 'lost'));
        }
        current = open({ id: input.id, severity: input.severity });
        return Promise.resolve(current);
      },
      changeIncident: () => {
        current = open({
          id: asked[0]?.id ?? ID,
          status: 'resolved',
          resolvedAt: '2026-09-09T12:00:00.000Z',
        });
        return Promise.resolve(current);
      },
    });
    const panel = await openPanel(view);
    await person().click(within(panel).getByRole('button', { name: 'Declare an incident' }));
    await settle();
    // Read back: it is open, though the answer was lost.
    await person().click(within(panel).getByRole('button', { name: 'Resolve…' }));
    await person().click(within(panel).getByRole('button', { name: 'Resolve' }));
    await settle();
    await person().click(within(panel).getByRole('button', { name: 'Declare an incident' }));
    await settle();
    expect(asked).toHaveLength(2);
    expect(asked[1]?.id).not.toBe(asked[0]?.id);
    view.unmountAll();
  });

  test('when whether one is open cannot be read, the channel says so with Retry, not calm', async () => {
    let failing = true;
    const view = await mount({
      incident: () =>
        failing
          ? Promise.reject(new ApiError(500, 'INTERNAL', 'boom'))
          : Promise.resolve({ incident: open({ severity: 1 }) }),
    });
    const unknown = view.getByRole('region', { name: 'Incident' });
    expect(unknown.textContent).toContain('Whether an incident is open here could not be read.');
    failing = false;
    await person().click(within(unknown).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByRole('region', { name: 'Incident in progress' }).textContent).toContain(
      'SEV1',
    );
    view.unmountAll();
  });

  test('responders on the timeline: themselves, somebody else, and somebody gone (D-137 §3)', async () => {
    const entries = (locale?: 'tr'): Promise<ChannelView> =>
      mount(
        {
          incident: () => Promise.resolve({ incident: open() }),
          incidentUpdates: () =>
            Promise.resolve({
              data: [
                {
                  id: '0199155c-6200-7b7f-8c11-0000000000f6',
                  at: DECLARED,
                  actor: ME,
                  change: { kind: 'responder_removed', user: null },
                },
                {
                  id: '0199155c-6200-7b7f-8c11-0000000000f5',
                  at: DECLARED,
                  actor: ME,
                  change: { kind: 'responder_added', user: ALICE },
                },
                {
                  id: '0199155c-6200-7b7f-8c11-0000000000f4',
                  at: DECLARED,
                  actor: ALICE,
                  change: { kind: 'responder_added', user: ALICE },
                },
              ],
              nextCursor: null,
            }),
        },
        locale === undefined ? {} : { locale },
      );
    const view = await entries();
    const panel = await openPanel(view);
    expect(within(panel).getByText('Alice is responding')).toBeDefined();
    expect(within(panel).getByText('Dogancan brought Alice in to respond')).toBeDefined();
    expect(within(panel).getByText('Dogancan took Someone off responding')).toBeDefined();
    view.unmountAll();
    const tr = await entries('tr');
    const panelTr = await openPanel(tr);
    expect(within(panelTr).getByText('Alice müdahale ediyor')).toBeDefined();
    tr.unmountAll();
  });

  describe('who is responding (D-137 §3)', () => {
    const members = (): Promise<{ user: typeof ME; joinedAt: string }[]> =>
      Promise.resolve([ME, ALICE, BOB].map((user) => ({ user, joinedAt: DECLARED })));

    test('listed with "you", and "I’m responding" paints at once and asks once', async () => {
      const asked: [string, boolean][] = [];
      let answer: (incident: Incident) => void = () => undefined;
      const view = await mount({
        incident: () => Promise.resolve({ incident: open({ responders: [ALICE] }) }),
        channelMembers: members,
        respond: (_channel, _id, userId, responding) => {
          asked.push([userId, responding]);
          return new Promise((resolve) => {
            answer = resolve;
          });
        },
      });
      const panel = await openPanel(view);
      const list = within(panel).getByRole('region', { name: '1 responding' });
      expect(within(list).getByText('Alice')).toBeDefined();
      await person().click(within(panel).getByRole('button', { name: 'I’m responding' }));
      // Before the answer: listed, as "you", and the button gone.
      expect(within(panel).getByText('Dogancan (you)')).toBeDefined();
      expect(within(panel).queryByRole('button', { name: 'I’m responding' })).toBeNull();
      expect(view.getByRole('region', { name: 'Incident in progress' }).textContent).toContain(
        '2 responding',
      );
      act(() => {
        answer(open({ responders: [ALICE, ME] }));
      });
      await settle();
      expect(asked).toEqual([[ME.id, true]]);
      await expectNoAxeViolations(panel);
      view.unmountAll();
    });

    test('somebody else is brought in from the channel’s members, and taken off; a refusal is put back', async () => {
      const asked: [string, boolean][] = [];
      let current = open({ responders: [] });
      const view = await mount({
        incident: () => Promise.resolve({ incident: current }),
        channelMembers: members,
        respond: (_channel, _id, userId, responding) => {
          asked.push([userId, responding]);
          if (!responding) return Promise.reject(new ApiError(500, 'INTERNAL', 'boom'));
          current = open({ responders: [BOB] });
          return Promise.resolve(current);
        },
      });
      const panel = await openPanel(view);
      expect(within(panel).getByText('Nobody is responding yet.')).toBeDefined();
      await person().click(within(panel).getByRole('button', { name: 'Bring someone in…' }));
      // The channel's members not responding, never the person themselves: they have their own button.
      expect(view.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
        'Alice',
        'Bob',
      ]);
      await person().click(view.getByRole('menuitem', { name: 'Bob' }));
      await settle();
      expect(within(panel).getByText('Bob')).toBeDefined();
      await person().click(within(panel).getByRole('button', { name: 'Take Bob off responding' }));
      await settle();
      // Refused: back as the server last said, and said.
      expect(within(panel).getByText('Bob')).toBeDefined();
      expect(view.getByText(/went wrong/i)).toBeDefined();
      expect(asked).toEqual([
        [BOB.id, true],
        [BOB.id, false],
      ]);
      view.unmountAll();
    });

    test('after I’m responding, the button is gone and focus is on the list’s heading, never nowhere', async () => {
      const view = await mount({
        incident: () => Promise.resolve({ incident: open({ responders: [] }) }),
        channelMembers: members,
        respond: () => Promise.resolve(open({ responders: [ME] })),
      });
      const panel = await openPanel(view);
      await person().click(within(panel).getByRole('button', { name: 'I’m responding' }));
      await settle();
      expectFocusOn(within(panel).getByRole('heading', { name: '1 responding' }));
      view.unmountAll();
    });

    test('when the channel’s members cannot be read, it says so with Retry instead of a missing menu', async () => {
      let failing = true;
      const view = await mount({
        incident: () => Promise.resolve({ incident: open({ responders: [] }) }),
        channelMembers: () =>
          failing ? Promise.reject(new ApiError(500, 'INTERNAL', 'boom')) : members(),
      });
      const panel = await openPanel(view);
      expect(within(panel).getByText('The channel’s members did not load.')).toBeDefined();
      expect(within(panel).queryByRole('button', { name: 'Bring someone in…' })).toBeNull();
      failing = false;
      await person().click(
        within(panel).getByRole('button', { name: 'Retry reading the channel’s members' }),
      );
      await settle();
      expect(within(panel).getByRole('button', { name: 'Bring someone in…' })).toBeDefined();
      view.unmountAll();
    });

    test('a later change refused while an earlier one is still on its way: the earlier one’s answer is shown', async () => {
      let answerRespond: (incident: Incident) => void = () => undefined;
      let refuseChange: (error: unknown) => void = () => undefined;
      let reads = 0;
      const view = await mount({
        incident: () => {
          reads += 1;
          // After the first, reads fail: what is shown is the actions' own doing.
          return reads === 1
            ? Promise.resolve({ incident: open({ responders: [] }) })
            : Promise.reject(new ApiError(500, 'INTERNAL', 'boom'));
        },
        channelMembers: members,
        respond: () =>
          new Promise((resolve) => {
            answerRespond = resolve;
          }),
        changeIncident: () =>
          new Promise((_resolve, reject) => {
            refuseChange = reject;
          }),
      });
      const panel = await openPanel(view);
      await person().click(within(panel).getByRole('button', { name: 'I’m responding' }));
      await person().click(within(panel).getByRole('button', { name: 'Mitigating' }));
      act(() => {
        refuseChange(new ApiError(500, 'INTERNAL', 'no'));
      });
      await settle();
      act(() => {
        answerRespond(open({ responders: [ME] }));
      });
      await settle();
      expect(within(panel).getByText('Dogancan (you)')).toBeDefined();
      view.unmountAll();
    });

    test('a visitor reads who is responding and is offered nothing', async () => {
      const view = await mount(
        {
          incident: () => Promise.resolve({ incident: open({ responders: [ALICE] }) }),
        },
        { member: false },
      );
      const panel = await openPanel(view);
      expect(within(panel).getByText('Alice')).toBeDefined();
      expect(within(panel).queryByRole('button', { name: 'I’m responding' })).toBeNull();
      expect(within(panel).queryByRole('button', { name: /Take .* off/ })).toBeNull();
      expect(within(panel).queryByRole('button', { name: 'Bring someone in…' })).toBeNull();
      view.unmountAll();
    });

    test('the banner shows the first three and how many more', async () => {
      const five = ['a1', 'a2', 'a3', 'a4', 'a5'].map((name, n) => ({
        id: `0199155c-6200-7b7f-8c11-0000000001${String(n).padStart(2, '0')}`,
        username: name,
        displayName: name.toUpperCase(),
        avatarUrl: null,
      }));
      const view = await mount({
        incident: () => Promise.resolve({ incident: open({ responders: five }) }),
      });
      const banner = view.getByRole('region', { name: 'Incident in progress' });
      expect(banner.querySelectorAll('[data-avatar]')).toHaveLength(3);
      expect(banner.textContent).toContain('+2');
      expect(banner.textContent).toContain('5 responding');
      view.unmountAll();
    });
  });

  describe('the runbook and the postmortem (D-137 §3, §5)', () => {
    let n = 0;
    /** Its own incident each: a postmortem draft is kept by incident while the page is. */
    const fresh = (over: Partial<Incident> = {}): Incident =>
      open({
        id: `0199155c-6200-7b7f-8c11-0000000002${String((n += 1)).padStart(2, '0')}`,
        ...over,
      });

    test('the runbook is a link opened apart; a member links, changes and removes it, painted at once', async () => {
      const asked: unknown[] = [];
      let current = fresh();
      const view = await mount({
        incident: () => Promise.resolve({ incident: current }),
        changeIncident: (_channel, _id, input) => {
          asked.push(input);
          current = { ...current, runbookUrl: input.runbookUrl ?? null };
          return Promise.resolve(current);
        },
      });
      const panel = await openPanel(view);
      expect(within(panel).getByText('No runbook linked.')).toBeDefined();
      await person().click(within(panel).getByRole('button', { name: 'Link the runbook' }));
      const field = within(panel).getByRole('textbox', { name: 'Runbook link' });
      await person().clear(field);
      await person().type(field, 'https://runbooks.example.test/db');
      await person().click(within(panel).getByRole('button', { name: 'Save' }));
      const link = within(panel).getByRole('link', { name: 'https://runbooks.example.test/db' });
      expect([link.getAttribute('target'), link.getAttribute('rel')]).toEqual([
        '_blank',
        'noopener noreferrer',
      ]);
      await settle();
      await person().click(within(panel).getByRole('button', { name: 'Remove' }));
      await settle();
      expect(within(panel).getByText('No runbook linked.')).toBeDefined();
      expect(asked).toEqual([
        { runbookUrl: 'https://runbooks.example.test/db' },
        { runbookUrl: null },
      ]);
      view.unmountAll();
    });

    test('the postmortem is drawn as a message is; written, it is saved from the version it began at', async () => {
      const saved: unknown[] = [];
      let current = fresh({ postmortem: '**Root cause** unknown', postmortemVersion: 3 });
      const view = await mount({
        incident: () => Promise.resolve({ incident: current }),
        savePostmortem: (_channel, _id, input) => {
          saved.push(input);
          current = { ...current, postmortem: input.content, postmortemVersion: 4 };
          return Promise.resolve(current);
        },
      });
      const panel = await openPanel(view);
      expect(within(panel).getByText('Root cause').tagName).toBe('STRONG');
      await person().click(within(panel).getByRole('button', { name: 'Edit' }));
      const editor = within(panel).getByRole('textbox', { name: 'Postmortem' });
      expectFocusOn(editor);
      await person().type(editor, ': the cache.');
      await person().click(within(panel).getByRole('button', { name: 'Save' }));
      await settle();
      expect(saved).toEqual([{ content: '**Root cause** unknown: the cache.', version: 3 }]);
      expect(within(panel).queryByRole('textbox', { name: 'Postmortem' })).toBeNull();
      view.unmountAll();
    });

    test('saved by somebody else meanwhile: the words stay, theirs is shown above, and saving again is from theirs', async () => {
      const saved: { content: string; version: number }[] = [];
      let current = fresh({ postmortem: '', postmortemVersion: 0 });
      const view = await mount({
        incident: () => Promise.resolve({ incident: current }),
        savePostmortem: (_channel, _id, input) => {
          saved.push(input);
          if (saved.length === 1) {
            current = { ...current, postmortem: 'theirs', postmortemVersion: 1 };
            return Promise.reject(new ApiError(409, 'INCIDENT_POSTMORTEM_CHANGED', 'changed'));
          }
          current = { ...current, postmortem: input.content, postmortemVersion: 2 };
          return Promise.resolve(current);
        },
      });
      const panel = await openPanel(view);
      await person().click(within(panel).getByRole('button', { name: 'Write the postmortem' }));
      await person().type(within(panel).getByRole('textbox', { name: 'Postmortem' }), 'mine');
      await person().click(within(panel).getByRole('button', { name: 'Save' }));
      await settle();
      expect(
        view.getByText(
          'Somebody else saved the postmortem since you began. Your text is kept: read theirs, then save again.',
        ),
      ).toBeDefined();
      expect(
        within(panel).getByRole<HTMLTextAreaElement>('textbox', { name: 'Postmortem' }).value,
      ).toBe('mine');
      expect(
        within(panel).getByRole('region', { name: 'Saved by somebody else meanwhile' }).textContent,
      ).toContain('theirs');
      await person().click(within(panel).getByRole('button', { name: 'Save' }));
      await settle();
      expect(saved).toEqual([
        { content: 'mine', version: 0 },
        { content: 'mine', version: 1 },
      ]);
      view.unmountAll();
    });

    test('a save after somebody else’s goes over only what the person was shown; one saved later is refused again', async () => {
      const saved: { content: string; version: number }[] = [];
      let current = fresh({ postmortem: '', postmortemVersion: 0 });
      const view = await mount({
        incident: () => Promise.resolve({ incident: current }),
        savePostmortem: (_channel, _id, input) => {
          saved.push(input);
          if (input.version !== current.postmortemVersion) {
            return Promise.reject(new ApiError(409, 'INCIDENT_POSTMORTEM_CHANGED', 'changed'));
          }
          current = {
            ...current,
            postmortem: input.content,
            postmortemVersion: current.postmortemVersion + 1,
          };
          return Promise.resolve(current);
        },
      });
      const panel = await openPanel(view);
      await person().click(within(panel).getByRole('button', { name: 'Write the postmortem' }));
      await person().type(within(panel).getByRole('textbox', { name: 'Postmortem' }), 'mine');
      // Somebody else saves first.
      current = { ...current, postmortem: 'theirs', postmortemVersion: 1 };
      await person().click(within(panel).getByRole('button', { name: 'Save' }));
      await settle();
      expect(
        within(panel).getByRole('region', { name: 'Saved by somebody else meanwhile' }).textContent,
      ).toContain('theirs');
      // And again, heard by a frame while the person reads: what they were shown stays what they saw.
      current = { ...current, postmortem: 'theirs, again', postmortemVersion: 2 };
      await act(async () => {
        view.world.sockets.open();
        view.world.sockets.deliver({
          event: 'INCIDENT_UPDATED',
          data: { channelId: IDS.api },
          ts: 0,
        });
        await Promise.resolve();
      });
      await settle();
      await person().click(within(panel).getByRole('button', { name: 'Save' }));
      await settle();
      // From the version shown (1), never the one not read (2): refused, and shown what came since.
      expect(saved.map((input) => input.version)).toEqual([0, 1]);
      expect(
        within(panel).getByRole('region', { name: 'Saved by somebody else meanwhile' }).textContent,
      ).toContain('theirs, again');
      view.unmountAll();
    });

    test('fixed while a save is on its way; saved or cancelled, focus is on Edit, never nowhere', async () => {
      let answer: (incident: Incident) => void = () => undefined;
      const current = fresh({ postmortem: 'before', postmortemVersion: 0 });
      const view = await mount({
        incident: () => Promise.resolve({ incident: current }),
        savePostmortem: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      });
      const panel = await openPanel(view);
      await person().click(within(panel).getByRole('button', { name: 'Edit' }));
      await person().click(within(panel).getByRole('button', { name: 'Save' }));
      expect(
        within(panel).getByRole('textbox', { name: 'Postmortem' }).hasAttribute('readonly'),
      ).toBe(true);
      await act(async () => {
        answer({ ...current, postmortem: 'before', postmortemVersion: 0 });
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await settle();
      expectFocusOn(within(panel).getByRole('button', { name: 'Edit' }));
      await person().click(within(panel).getByRole('button', { name: 'Edit' }));
      await person().click(within(panel).getByRole('button', { name: 'Cancel' }));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expectFocusOn(within(panel).getByRole('button', { name: 'Edit' }));
      view.unmountAll();
    });

    test('a refused runbook link brings the form back with what was typed; Cancel gives focus back', async () => {
      const view = await mount({
        incident: () => Promise.resolve({ incident: fresh() }),
        changeIncident: () =>
          Promise.reject(
            new ApiError(400, 'VALIDATION_FAILED', 'no', { runbookUrl: 'must be an https link' }),
          ),
      });
      const panel = await openPanel(view);
      await person().click(within(panel).getByRole('button', { name: 'Link the runbook' }));
      await person().click(within(panel).getByRole('button', { name: 'Cancel' }));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expectFocusOn(within(panel).getByRole('button', { name: 'Link the runbook' }));
      await person().click(within(panel).getByRole('button', { name: 'Link the runbook' }));
      const field = within(panel).getByRole('textbox', { name: 'Runbook link' });
      await person().clear(field);
      await person().type(field, 'https://runbooks.example.test/typed');
      await person().click(within(panel).getByRole('button', { name: 'Save' }));
      await settle();
      expect(
        within(panel).getByRole<HTMLInputElement>('textbox', { name: 'Runbook link' }).value,
      ).toBe('https://runbooks.example.test/typed');
      view.unmountAll();
    });

    test('a draft outlives the panel closing, and a visitor reads both and is offered neither', async () => {
      const current = fresh({ postmortem: 'kept', runbookUrl: 'https://runbooks.example.test/x' });
      const view = await mount({ incident: () => Promise.resolve({ incident: current }) });
      let panel = await openPanel(view);
      await person().click(within(panel).getByRole('button', { name: 'Edit' }));
      await person().type(within(panel).getByRole('textbox', { name: 'Postmortem' }), ' and more');
      await person().keyboard('{Escape}');
      await settle();
      panel = await openPanel(view);
      expect(
        within(panel).getByRole<HTMLTextAreaElement>('textbox', { name: 'Postmortem' }).value,
      ).toBe('kept and more');
      view.unmountAll();

      const visitor = await mount(
        {
          incident: () =>
            Promise.resolve({
              incident: fresh({
                postmortem: 'kept',
                runbookUrl: 'https://runbooks.example.test/x',
              }),
            }),
        },
        { member: false },
      );
      const read = await openPanel(visitor);
      expect(
        within(read).getByRole('link', { name: 'https://runbooks.example.test/x' }),
      ).toBeDefined();
      expect(within(read).getByText('kept')).toBeDefined();
      expect(within(read).queryByRole('button', { name: 'Edit' })).toBeNull();
      expect(within(read).queryByRole('button', { name: 'Change' })).toBeNull();
      await expectNoAxeViolations(read);
      visitor.unmountAll();
    });
  });

  test('in Turkish, it speaks Turkish', async () => {
    const view = await mount(
      { incident: () => Promise.resolve({ incident: open() }) },
      { locale: 'tr' },
    );
    expect(view.getByRole('region', { name: 'Süren olay' }).textContent).toContain('İnceleniyor');
    const panel = await openPanel(view);
    expect(within(panel).getByText('Alice olayı SEV2 olarak bildirdi')).toBeDefined();
    expect(within(panel).getByRole('button', { name: 'Hafifletiliyor' })).toBeDefined();
    view.unmountAll();
  });

  test('on a narrow window the Channel menu opens the incident', async () => {
    const view = await mount({ incident: () => Promise.resolve({ incident: null }) });
    await person().click(view.getByRole('button', { name: 'Channel menu' }));
    await person().click(view.getByRole('menuitem', { name: 'Incident' }));
    await settle();
    expect(
      within(view.getByRole('complementary', { name: /Incident/ })).getByText('No incident'),
    ).toBeDefined();
    view.unmountAll();
  });

  test('a conversation has no incident: no banner, no control', async () => {
    const dm = aChannel(IDS.dm, null, { type: 'direct_message', peer: ALICE });
    const view = await mountChannel({
      channelId: IDS.dm,
      channels: [...someChannels(), dm],
      messages: page([]),
    });
    expect(view.queryByRole('button', { name: 'Incident' })).toBeNull();
    expect(view.queryByRole('region', { name: 'Incident in progress' })).toBeNull();
    view.unmountAll();
  });
});
