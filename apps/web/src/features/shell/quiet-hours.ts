/**
 * Whether it is the person's quiet hours now (D-234): read once from the server, then again at each
 * minute's turn, so the open page goes quiet as Deep Work makes it — no notice, no count in the tab — when
 * the window opens, and speaks again when it closes. The server holds back what would reach their devices
 * on its own. The clock and the timer are the realtime ports', so a test moves time itself.
 */
import { isQuietAt, type QuietHoursSetting } from '@purlay/types';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useContext, useEffect, useState } from 'react';
import { useApi } from '../../data/api-provider';
import { keys } from '../../data/keys';
import { RealtimePortsContext } from '../../realtime/realtime-provider';
import { browserSchedule } from '../../realtime/socket';
import { systemClock } from '../../system-clock';

const MINUTE_MS = 60_000;

/** The person's quiet hours as the server keeps them: read once, and set again by whoever saves them. */
export const useQuietHoursSetting = (): UseQueryResult<QuietHoursSetting> => {
  const api = useApi();
  return useQuery({
    queryKey: keys.quietHours,
    queryFn: async ({ signal }) => await api.quietHours(signal),
    staleTime: Infinity,
  });
};

export const useQuietHoursNow = (): boolean => {
  const ports = useContext(RealtimePortsContext);
  const clock = ports.clock ?? systemClock;
  const schedule = ports.schedule ?? browserSchedule;
  const setting = useQuietHoursSetting();
  const [now, setNow] = useState(() => clock.now());
  // The next minute's turn, and then the one after: a window opens and closes on the minute.
  useEffect(
    () =>
      schedule(
        () => {
          setNow(clock.now());
        },
        MINUTE_MS - (now.getTime() % MINUTE_MS),
      ),
    [now, schedule, clock],
  );
  const window = setting.data?.quietHours ?? null;
  const zone = setting.data?.timeZone ?? null;
  return window !== null && zone !== null && isQuietAt(window, zone, now);
};
