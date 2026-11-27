/**
 * The `MemberDepartures` of a test (D-355): one that tells nobody, for a test of a path that ends a membership and is about something
 * else, and one that keeps what it was told, for a test of which departures a path reports.
 */
import type { MemberLeftReason } from '@purlay/types';
import type { MemberDepartures } from '../modules/workspaces/member-departures';

export const noDepartures: MemberDepartures = () => Promise.resolve();

export interface ToldDeparture {
  readonly workspaceId: string;
  readonly userId: string;
  readonly reason: MemberLeftReason;
}

export const recordedDepartures = (): {
  readonly departures: MemberDepartures;
  readonly told: readonly ToldDeparture[];
} => {
  const told: ToldDeparture[] = [];
  return {
    told,
    departures: (_transaction, workspaceId, userIds, reason): Promise<void> => {
      told.push(...userIds.map((userId) => ({ workspaceId, userId, reason })));
      return Promise.resolve();
    },
  };
};
