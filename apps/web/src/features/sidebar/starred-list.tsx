/**
 * The Starred section (#489, D-132): the channels the person keeps at hand, above Channels and out
 * of it, by name. Not there until something is starred — an empty section would only be noise —
 * and it shares the channel list's states, so it says nothing while that one says what is wrong. The person
 * may fold it (D-195); a channel they starred stays listed whatever they ask to leave out, muted or not — they
 * put it there.
 */
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { useRoute } from '../../router/router-provider';
import { useWorkspace } from '../shell/workspace';
import { ChannelRow } from './channel-row';
import { starredChannels } from './ordering';
import { useSidebarPreferences } from './preferences-context';
import { rowOf, shownRows, withToggled } from './preferences';
import { SectionHeading } from './section-heading';

export const StarredList = (): React.JSX.Element | null => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const { match } = useRoute();
  const currentId = match.name === 'channel' ? match.params.channelId : null;
  const { preferences, change } = useSidebarPreferences();
  const starred = starredChannels(channels.data ?? []);
  if (starred.length === 0) return null;
  const collapsed = preferences.collapsed.includes('starred');
  const shown = shownRows(
    starred.map((channel) => ({ ...rowOf(channel), channel })),
    { collapsed, unreadOnly: preferences.unreadOnly, hideMuted: false, currentId },
  );
  return (
    <nav aria-label={t('sidebar.starred')} className="flex flex-col">
      <SectionHeading
        controls="sidebar-list-starred"
        collapsed={collapsed}
        onToggle={() => {
          change({ collapsed: withToggled(preferences.collapsed, 'starred') });
        }}
      >
        {t('sidebar.starred')}
      </SectionHeading>
      <ul id="sidebar-list-starred" className="flex flex-col">
        {shown.map(({ channel }) => (
          <li key={channel.id}>
            <ChannelRow
              slug={workspace.slug}
              channel={channel}
              glyph={channel.type === 'private' ? 'private-channel' : 'channel'}
              current={channel.id === currentId}
              unread={(channel.state?.unreadCount ?? 0) > 0}
              mentions={channel.state?.unreadMentionCount ?? 0}
              incident={channel.incident}
              muted={channel.notificationLevel === 'none'}
            >
              {channel.name}
            </ChannelRow>
          </li>
        ))}
      </ul>
    </nav>
  );
};
