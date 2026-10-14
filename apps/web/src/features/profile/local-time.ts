/**
 * The time it is where somebody is (D-131): their profile's zone, at the current minute, in the
 * reader's language — "14:32". Ticks with the feed's minute (`now-minute.ts`), so a test moves it.
 *
 * A zone this browser cannot format in — its own list of zones is older than the server's — shows
 * no time rather than a wrong one; the profile panel still names the zone.
 */
import { useMemo } from 'react';
import type { Profile, WorkspaceMember } from '@purlay/types';
import { useMembers } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { useFeedPorts } from '../channel/feed-ports';
import { useNowMinute } from '../channel/now-minute';
import { useWorkspace } from '../shell/workspace';

const timeIn = (timeZone: string, at: number, locale: string): string | null => {
  try {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone }).format(
      at,
    );
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  return null;
};

/** The time where a profile's person is, now; null when they have no zone or it cannot be shown. */
export const useLocalTime = (profile: Profile | undefined): string | null => {
  const { locale } = useI18n();
  const now = useNowMinute(useFeedPorts());
  const zone = profile?.timeZone ?? null;
  return useMemo(() => (zone === null ? null : timeIn(zone, now, locale)), [zone, now, locale]);
};

/** A workspace member by their user id, from the members the workspace already holds. */
export const useMember = (userId: string): WorkspaceMember | undefined => {
  const { workspace } = useWorkspace();
  const members = useMembers(workspace.id);
  return members.data?.find((member) => member.user.id === userId);
};
