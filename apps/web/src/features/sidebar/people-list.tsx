/**
 * The People section: everyone in the workspace, and the conversations already open
 * with them.
 *
 * A person with a direct message is a link to it (and carries its unread treatment); a
 * person without one is a button that opens it — `POST …/dms` is idempotent, so pressing
 * twice, or from two tabs, lands in the same channel (I-5). The person themselves is in
 * the list, labelled "you": a direct message with yourself is the scratchpad
 * (`PRD.md` §4.3). Each has an avatar, with a dot when the person is online (D-136) and "online"
 * said beside the name to a screen reader; nothing when they are not, or nothing is known.
 *
 * Alone in a workspace, the section says so under the person's own row (`UX.md` §8), and offers an
 * owner or an admin the invite dialog the workspace menu opens; a member is not offered what the
 * server would refuse them (D-115). The person may fold the section or switch it off (D-195); a person with no
 * conversation yet has nothing waiting, so a folded section, or only what is unread, lists the ones who do.
 */
import { useDescribeFailure } from '../../data/failure';
import { useMemo, useState } from 'react';
import { useDeferred } from '../../app/deferred-door';
import { useActions } from '../../data/actions-provider';
import { useChannels, useMembers } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Avatar } from '../../ui/avatar';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { useOnline } from '../../realtime/realtime-provider';
import type { User } from '@purlay/types';
import { Button } from '../../ui/button';
import { useToast } from '../../ui/toast';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';
import { ActionRow, ChannelRow } from './channel-row';
import { people } from './ordering';
import { useSidebarPreferences } from './preferences-context';
import { rowOf, shownRows, withToggled } from './preferences';
import { SectionHeading } from './section-heading';
import { SectionEmpty, SectionError, SectionLoading } from './section-state';

/** A person's avatar, with the dot that says they are online (D-136). */
const PersonAvatar = ({
  user,
  meId,
}: {
  readonly user: User;
  readonly meId: string;
}): React.JSX.Element => (
  <Avatar
    size="sm"
    name={user.displayName}
    username={user.username}
    online={useOnline(user.id, meId)}
  />
);

/** What the dot says, said to a screen reader beside the name. */
const OnlineWords = ({
  userId,
  meId,
}: {
  readonly userId: string;
  readonly meId: string;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  return useOnline(userId, meId) === true ? (
    <VisuallyHidden>{`, ${t('presence.online')}`}</VisuallyHidden>
  ) : null;
};

export const PeopleList = (): React.JSX.Element | null => {
  const { t } = useI18n();
  const { workspace, role } = useWorkspace();
  const { user: me } = useSession();
  const members = useMembers(workspace.id);
  const channels = useChannels(workspace.id);
  const { openDirectMessage } = useActions();
  const { match, navigate } = useRoute();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const [opening, setOpening] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  // The dialog is in the deferred chunk (D-163).
  const deferred = useDeferred([inviting, setInviting]);
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
  // Every message moves the channels' cache; sorting every member again is only owed when they change.
  const entries = useMemo(
    () => people(members.data ?? [], channels.data ?? []),
    [members.data, channels.data],
  );
  const alone = entries.every((entry) => entry.user.id === me.id);
  const mayInvite = role === 'owner' || role === 'admin';
  const { preferences, change } = useSidebarPreferences();
  const collapsed = preferences.collapsed.includes('people');
  const off = preferences.hidden.includes('people');
  const rows = entries.map((entry) => ({
    ...(entry.direct === null
      ? { id: entry.user.id, unread: false, mentions: 0, muted: false, incident: false }
      : rowOf(entry.direct)),
    entry,
  }));
  // Switched off, the section is drawn only for the person whose conversation is open (a row with a
  // conversation is that channel's, so the open one is the one the address names).
  const shown = off
    ? rows.filter((row) => row.id === currentId)
    : shownRows(rows, {
        collapsed,
        unreadOnly: preferences.unreadOnly,
        // A muted conversation is still somebody, and the only way to open it: only channels are left out.
        hideMuted: false,
        currentId,
      });
  if (off && shown.length === 0) return null;

  return (
    <section aria-labelledby="sidebar-people" className="flex flex-col">
      <SectionHeading
        id="sidebar-people"
        controls="sidebar-list-people"
        collapsed={collapsed}
        onToggle={() => {
          change({ collapsed: withToggled(preferences.collapsed, 'people') });
        }}
      >
        {t('sidebar.people')}
      </SectionHeading>
      <div id="sidebar-list-people">
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
            {shown.map(({ entry: { user, direct } }) => {
              const label = (
                <>
                  {user.displayName}
                  {user.id === me.id ? (
                    // A tag beside the name, not a second word of it: smaller and quieter, as Slack's is.
                    <span className="font-normal text-caption text-nav-ink-muted">
                      {' '}
                      {t('sidebar.you')}
                    </span>
                  ) : null}
                  <OnlineWords userId={user.id} meId={me.id} />
                </>
              );
              return (
                <li key={user.id}>
                  {direct === null ? (
                    <ActionRow
                      avatar={<PersonAvatar user={user} meId={me.id} />}
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
                      channel={direct}
                      current={direct.id === currentId}
                      avatar={<PersonAvatar user={user} meId={me.id} />}
                      unread={(direct.state?.unreadCount ?? 0) > 0}
                      mentions={direct.state?.unreadMentionCount ?? 0}
                      muted={direct.notificationLevel === 'none'}
                    >
                      {label}
                    </ChannelRow>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {!waiting && !failed && alone && !off && !collapsed && !preferences.unreadOnly ? (
          <SectionEmpty
            title={t('sidebar.people.empty')}
            body={t('sidebar.people.emptyBody')}
            {...(mayInvite
              ? {
                  action: (
                    <Button
                      glyph="person"
                      onClick={() => {
                        setInviting(true);
                      }}
                    >
                      {t('invite.admin.entry')}
                    </Button>
                  ),
                }
              : {})}
          />
        ) : null}
      </div>
      {mayInvite && deferred !== null ? (
        <deferred.InviteDialog open={inviting} onOpenChange={setInviting} />
      ) : null}
    </section>
  );
};
