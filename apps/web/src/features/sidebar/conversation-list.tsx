/**
 * The sidebar's group conversations (D-127): each a row named by its people and drawn with the
 * faces of the first two (D-167), most recently active first, and New message, which starts one. A conversation of two is a person, and stays under
 * People. The person may fold the section or switch it off (D-195).
 */
import { useState } from 'react';
import { useDeferred } from '../../app/deferred-door';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { useRoute } from '../../router/router-provider';
import { IconButton } from '../../ui/icon-button';
import { GroupFace } from '../conversations/group-face';
import { nameOf } from '../messages/author';
import { useWorkspace } from '../shell/workspace';
import { ChannelRow } from './channel-row';
import { groups } from './ordering';
import { useSidebarPreferences } from './preferences-context';
import { rowOf, shownRows, withToggled } from './preferences';
import { SectionHeading } from './section-heading';

export const ConversationList = (): React.JSX.Element | null => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const { match } = useRoute();
  const [starting, setStarting] = useState(false);
  // The dialog is in the deferred chunk (D-163).
  const deferred = useDeferred([starting, setStarting]);
  const currentId = match.name === 'channel' ? match.params.channelId : null;
  // The channel list says when channels are loading or failed; this section only adds to it.
  const all = groups(channels.data ?? []);
  const { preferences, change } = useSidebarPreferences();
  const collapsed = preferences.collapsed.includes('conversations');
  const off = preferences.hidden.includes('conversations');
  const rows = all.map((group) => ({ ...rowOf(group), group }));
  // Switched off, the section is drawn only for the conversation the person is in: it is not taken from under them.
  const list = off
    ? rows.filter((row) => row.id === currentId)
    : shownRows(rows, {
        collapsed,
        unreadOnly: preferences.unreadOnly,
        // Only channels are left out for being muted: a conversation with people is not a place to leave.
        hideMuted: false,
        currentId,
      });
  if (off && list.length === 0) return null;

  return (
    <section aria-labelledby="sidebar-conversations" className="flex flex-col">
      <SectionHeading
        id="sidebar-conversations"
        controls="sidebar-list-conversations"
        collapsed={collapsed}
        onToggle={() => {
          change({ collapsed: withToggled(preferences.collapsed, 'conversations') });
        }}
        actions={
          <IconButton
            label={t('conversations.new')}
            glyph="add"
            size="nav"
            onClick={() => {
              setStarting(true);
            }}
          />
        }
      >
        {t('conversations.title')}
      </SectionHeading>
      <div id="sidebar-list-conversations">
        {channels.isSuccess && all.length === 0 ? (
          <p className="px-2 py-1 text-caption text-nav-ink-muted">{t('conversations.empty')}</p>
        ) : (
          <ul className="flex flex-col">
            {list.map(({ group }) => {
              const current = group.id === currentId;
              return (
                <li key={group.id}>
                  <ChannelRow
                    slug={workspace.slug}
                    channel={group}
                    current={current}
                    avatar={<GroupFace peers={group.peers} surface={current ? 'current' : 'nav'} />}
                    unread={(group.state?.unreadCount ?? 0) > 0}
                    mentions={group.state?.unreadMentionCount ?? 0}
                    muted={group.notificationLevel === 'none'}
                  >
                    {group.peers.map((person) => nameOf(person, t('user.erased'))).join(', ')}
                  </ChannelRow>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {deferred !== null && (
        <deferred.NewConversationDialog open={starting} onOpenChange={setStarting} />
      )}
    </section>
  );
};
