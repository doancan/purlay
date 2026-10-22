/**
 * The browser tab's title: where the person is, in which workspace, and how much needs them
 * (`UX.md` §2) — read in the tab strip while the person is elsewhere, beside the icon's dot and the
 * browser's notice an open tab in the background shows (D-148).
 *
 * The count is the sidebar's: the sum of the channels' `unreadMentionCount`, which is what *needs
 * you* (D-106, D-107) — a mention, a direct message, an answer in a thread you are in — and never
 * the plain unread messages, which interrupt nobody. It arrives over the socket into the same cache
 * entry the badges read, so the two cannot disagree; and in Deep Work, where the badges are not
 * drawn, the title does not count either.
 */
import { nameOf } from '../messages/author';
import { useEffect } from 'react';
import type { Channel } from '@purlay/types';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import type { Translate } from '../../i18n/types';
import { useRoute } from '../../router/router-provider';
import { useSession } from '../session/session';
import { useIsServerAdmin, useWorkspaceRole } from '../settings/role';
import { FIRST_SECTION, sectionFor } from '../settings/sections';
import { useDeepWork } from './deep-work';
import { useWorkspace } from './workspace';

/** What needs the person across the workspace: the badges, added up. */
export const waitingCount = (channels: readonly Channel[]): number =>
  channels.reduce((sum, channel) => sum + (channel.state?.unreadMentionCount ?? 0), 0);

/**
 * A conversation's name where there is no room for more: `#channel`, the other person in a direct
 * message, a group's people (D-127). The tab's title says it, and so does a notice (D-148).
 */
export const placeOf = (t: Translate, channel: Channel, me: string): string | null => {
  const peer = channel.peer;
  if (channel.type === 'direct_message' && peer !== null) {
    const name = nameOf(peer, t('user.erased'));
    return peer.id === me ? t('feed.selfDm', { name }) : name;
  }
  if (channel.type === 'direct_message' && channel.peers.length > 0) {
    return channel.peers.map((person) => nameOf(person, t('user.erased'))).join(', ');
  }
  return typeof channel.name === 'string' ? `#${channel.name}` : null;
};

/** The title, from its parts; `place` is null where the address names only the workspace. */
export const tabTitle = (
  t: Translate,
  { place, workspace, waiting }: { place: string | null; workspace: string; waiting: number },
): string => {
  const title =
    place === null ? t('app.tab.workspace', { workspace }) : t('app.tab', { place, workspace });
  return waiting > 0 ? t('app.tab.waiting', { count: waiting, title }) : title;
};

/** Sets the title while the shell is up; leaving it puts back what the page had. */
export const TabTitle = (): null => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { user } = useSession();
  const { match } = useRoute();
  const channels = useChannels(workspace.id).data ?? [];
  const quiet = useDeepWork().until !== null;
  const role = useWorkspaceRole();
  const serverAdmin = useIsServerAdmin();

  let place: string | null = null;
  if (match.name === 'inbox') place = t('inbox.title');
  else if (match.name === 'search') place = t('search.title');
  else if (match.name === 'saved') place = t('saved.title');
  else if (match.name === 'welcome') place = t('welcome.title');
  else if (match.name === 'questions') place = t('questions.title');
  else if (match.name === 'settings' || match.name === 'settingsHome') {
    // The page, as the navigation names it; one this person may not open is only *Settings*.
    const section = sectionFor(
      match.name === 'settings' ? match.params.section : FIRST_SECTION,
      role,
      serverAdmin,
    );
    place =
      section === null
        ? t('settings.title')
        : t('app.tab.settings', { section: t(`settings.${section.id}.nav`) });
  } else if (match.name === 'channel') {
    const channel = channels.find((c) => c.id === match.params.channelId);
    if (channel !== undefined) place = placeOf(t, channel, user.id);
  }
  const title = tabTitle(t, {
    place,
    workspace: workspace.name,
    waiting: quiet ? 0 : waitingCount(channels),
  });

  useEffect(() => {
    const before = document.title;
    document.title = title;
    return (): void => {
      document.title = before;
    };
  }, [title]);
  return null;
};
