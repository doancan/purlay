/**
 * The person's notification levels for a while end at their instants (D-329): the channels are read again at the
 * earliest end, so the sidebar and the header show the level the server has put back, without a reload. Apart from
 * the bell's menu, which loads with a channel, because the sidebar that runs it is drawn first.
 */
import { useContext, useEffect } from 'react';
import type { Channel } from '@purlay/types';
import { useQueryClient } from '@tanstack/react-query';
import { readAgain } from '../../../data/cache';
import { keys } from '../../../data/keys';
import { RealtimePortsContext } from '../../../realtime/realtime-provider';
import { browserSchedule } from '../../../lib/schedule';
import { systemClock } from '../../../system-clock';

export const LevelEnds = ({
  workspaceId,
  channels,
}: {
  readonly workspaceId: string;
  readonly channels: readonly Channel[];
}): null => {
  const client = useQueryClient();
  const ports = useContext(RealtimePortsContext);
  const clock = ports.clock ?? systemClock;
  const schedule = ports.schedule ?? browserSchedule;
  const now = clock.now().getTime();
  let next: number | undefined;
  for (const channel of channels) {
    const end = Date.parse(channel.notificationLevelUntil ?? '');
    if (end > now && (next === undefined || end < next)) next = end;
  }
  useEffect(
    () =>
      next === undefined
        ? undefined
        : schedule(() => {
            readAgain(client, keys.channels(workspaceId));
          }, next - clock.now().getTime()),
    [client, clock, next, schedule, workspaceId],
  );
  return null;
};
