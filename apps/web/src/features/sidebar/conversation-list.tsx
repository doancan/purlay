/**
 * The sidebar's group conversations (D-127): each a row named by its people and drawn with the
 * faces of the first two (D-166), most recently active first, and New message, which starts one. A conversation of two is a person, and stays under
 * People.
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

export const ConversationList = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const { match } = useRoute();
  const [starting, setStarting] = useState(false);
  // The dialog is in the deferred chunk (D-163).
  const deferred = useDeferred([starting, setStarting]);
  const currentId = match.name === 'channel' ? match.params.channelId : null;
  // The channel list says when channels are loading or failed; this section only adds to it.
  const list = groups(channels.data ?? []);

  return (
    <section aria-labelledby="sidebar-conversations" className="flex flex-col">
      <div className="flex items-center justify-between pl-2">
        <h2 id="sidebar-conversations" className="py-1 text-label text-nav-ink-muted">
          {t('conversations.title')}
        </h2>
        <IconButton
          label={t('conversations.new')}
          glyph="add"
          size="nav"
          onClick={() => {
            setStarting(true);
          }}
        />
      </div>
      {channels.isSuccess && list.length === 0 ? (
        <p className="px-2 py-1 text-caption text-nav-ink-muted">{t('conversations.empty')}</p>
      ) : (
        <ul className="flex flex-col">
          {list.map((group) => {
            const current = group.id === currentId;
            return (
              <li key={group.id}>
                <ChannelRow
                  slug={workspace.slug}
                  channel={group}
                  current={current}
                  avatar={
                    <GroupFace peers={group.peers} surface={current ? 'nav-current' : 'nav'} />
                  }
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
      {deferred !== null && (
        <deferred.NewConversationDialog open={starting} onOpenChange={setStarting} />
      )}
    </section>
  );
};
