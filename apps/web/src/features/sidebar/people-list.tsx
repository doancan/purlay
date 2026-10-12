/**
 * The People section: everyone in the workspace, and the conversations already open
 * with them.
 *
 * A person with a direct message is a link to it (and carries its unread treatment); a
 * person without one is a button that opens it — `POST …/dms` is idempotent, so pressing
 * twice, or from two tabs, lands in the same channel (I-5). The person themselves is in
 * the list, labelled "you": a direct message with yourself is the scratchpad
 * (`PRD.md` §4.3). Each has an avatar and none has a presence dot, because there is no
 * presence — drawing a dot that is always the same colour would be a lie (`UX.md` §2).
 */
import { useDescribeFailure } from '../../data/failure';
import { useState } from 'react';
import { useActions } from '../../data/actions-provider';
import { useChannels, useMembers } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Avatar } from '../../ui/avatar';
import { useToast } from '../../ui/toast';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';
import { ActionRow, ChannelRow } from './channel-row';
import { people } from './ordering';
import { SectionError, SectionLoading } from './section-state';

export const PeopleList = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { user: me } = useSession();
  const members = useMembers(workspace.id);
  const channels = useChannels(workspace.id);
  const { openDirectMessage } = useActions();
  const { match, navigate } = useRoute();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const [opening, setOpening] = useState<string | null>(null);
  const currentId = match.name === 'channel' ? match.params.channelId : null;

  const open = async (userId: string): Promise<void> => {
    setOpening(userId);
    try {
      const channel = await openDirectMessage(workspace.id, userId);
      navigate(href('channel', { slug: workspace.slug, channelId: channel.id }));
    } catch (failure) {
      show({ message: `${t('sidebar.dm.failed')} ${describe(failure)}` });
    } finally {
      setOpening(null);
    }
  };

  // The channel list's own state is the channel section's to show; here it only decides
  // whether a name has a conversation behind it, so waiting for it is waiting for both.
  const failed = members.isError || channels.isError;
  const waiting = members.isPending || channels.isPending;
  const entries = people(members.data ?? [], channels.data ?? []);

  return (
    <section aria-labelledby="sidebar-people" className="flex flex-col">
      <h2 id="sidebar-people" className="px-2 py-1 text-label text-nav-ink-muted">
        {t('sidebar.people')}
      </h2>
      {waiting && !failed ? (
        <SectionLoading label={t('common.loading')} />
      ) : failed ? (
        <SectionError
          title={t('state.channels.error.title')}
          body={t('state.channels.error.body')}
          retryLabel={t('common.retry')}
          onRetry={() => {
            void members.refetch();
            void channels.refetch();
          }}
        />
      ) : (
        <ul className="flex flex-col">
          {entries.map(({ user, direct }) => {
            const label = (
              <>
                {user.displayName}
                {user.id === me.id ? (
                  <span className="font-normal"> {t('sidebar.you')}</span>
                ) : null}
              </>
            );
            return (
              <li key={user.id}>
                {direct === null ? (
                  <ActionRow
                    avatar={<Avatar size="sm" name={user.displayName} username={user.username} />}
                    unread={false}
                    mentions={0}
                    disabled={opening === user.id}
                    onClick={() => {
                      void open(user.id);
                    }}
                  >
                    {label}
                  </ActionRow>
                ) : (
                  <ChannelRow
                    slug={workspace.slug}
                    channelId={direct.id}
                    current={direct.id === currentId}
                    avatar={<Avatar size="sm" name={user.displayName} username={user.username} />}
                    unread={(direct.state?.unreadCount ?? 0) > 0}
                    mentions={direct.state?.unreadMentionCount ?? 0}
                  >
                    {label}
                  </ChannelRow>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
