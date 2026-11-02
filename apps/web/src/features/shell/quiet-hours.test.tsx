/**
 * Whether it is the person's quiet hours now (D-234): what the server keeps, read on the profile's clock,
 * and read again at the minute's turn — the page goes quiet when the window opens without a reload.
 */
import { describe, expect, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { QuietHoursSetting } from '@purlay/types';
import { ApiProvider } from '../../data/api-provider';
import { RealtimePortsContext } from '../../realtime/realtime-provider';
import { installDom } from '../../testing/dom';
import { anApi } from '../../testing/fake-api';
import { fakeSchedule } from '../../testing/fakes';
import { useQuietHoursNow } from './quiet-hours';

installDom();

/** Wednesday 2026-09-09, 18:59:30 UTC: half a minute before an evening window opens. */
const START = Date.UTC(2026, 8, 9, 18, 59, 30);

interface Hooked {
  readonly view: ReturnType<typeof renderHook<boolean, unknown>>;
  readonly advance: (ms: number) => void;
}

const aHook = (setting: QuietHoursSetting): Hooked => {
  let now = START;
  const timers = fakeSchedule();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderHook(() => useQuietHoursNow(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <ApiProvider api={anApi({ quietHours: () => Promise.resolve(setting) })}>
          <RealtimePortsContext.Provider
            value={{ clock: { now: () => new Date(now) }, schedule: timers.schedule }}
          >
            {children}
          </RealtimePortsContext.Provider>
        </ApiProvider>
      </QueryClientProvider>
    ),
  });
  const advance = (ms: number): void => {
    now += ms;
    act(() => {
      timers.advance(ms);
    });
  };
  return { view, advance };
};

const EVENINGS = { from: 19 * 60, to: 7 * 60, days: [3] };

describe('quiet hours, now', () => {
  test('opens at the minute’s turn, without a reload', async () => {
    const { view, advance } = aHook({ quietHours: EVENINGS, timeZone: 'UTC' });
    await waitFor(() => {
      expect(view.result.current).toBe(false);
    });
    advance(30_000);
    expect(view.result.current).toBe(true);
    view.unmount();
  });

  test('with no window, or no time zone to read it in, it is never quiet', async () => {
    for (const setting of [
      { quietHours: null, timeZone: 'UTC' },
      { quietHours: EVENINGS, timeZone: null },
    ]) {
      const { view, advance } = aHook(setting);
      advance(60_000);
      await waitFor(() => {
        expect(view.result.current).toBe(false);
      });
      view.unmount();
    }
  });
});
