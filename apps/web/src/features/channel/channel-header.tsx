/**
 * The channel's header: its name, what it is for, and the two ways to look at it —
 * the feed and its open questions, with their live count (`UX.md` §2, §4.4).
 *
 * A channel's name is set in the mono face with a `#`, like the sidebar's (the approved
 * prototype's choice: this is where code gets pasted). A direct message has no name, so it
 * shows the other person; a note to oneself says so. The count beside "Open questions" is
 * this channel's share of the number the sidebar shows, counted from the same cache entry
 * (`use-open-count.ts`), so the two cannot disagree.
 */
import { nameOf } from '../messages/author';
import { lazy, Suspense, useState } from 'react';
import { useDeferred } from '../../app/deferred-door';
import type { Channel } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { Link } from '../../router/router-provider';
import { narrowedTo } from '../../router/routes';
import { Avatar } from '../../ui/avatar';
import { GroupFace } from '../conversations/group-face';
import { cn } from '../../ui/cn';
import { useOpenCount } from '../questions/use-open-count';
import { NavToggle } from '../shell/nav';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';
import { IconButton } from '../../ui/icon-button';
import { NotificationLevelMenu } from './notification-level-menu';
import { PanelControls } from './panel-controls';
import { PeerHeading } from '../profile/peer-heading';
import { StarToggle } from './star-toggle';
import { useOnline } from '../../realtime/realtime-provider';
import { VisuallyHidden } from '../../ui/visually-hidden';

/**
 * Channel details, a chunk of its own (D-49, #687): opened by a click on the name a few times a
 * week, it is not paid for by every first load. Mounted on first opening and kept, so it closes as a
 * dialog closes and opens again at once.
 */
const ChannelDetailsDialog = lazy(async () => ({
  default: (await import('./channel-details')).ChannelDetailsDialog,
}));

/** One segment of the header's two-way control: the feed, or the open questions. */
export const segmentClasses =
  'inline-flex h-6 items-center gap-2 whitespace-nowrap rounded-md px-3 text-label transition-colors duration-hover ease-standard hover:text-ink max-narrow:h-touch';
/** The segment the person is on: raised out of the track by a one-pixel card shadow (D-110). */
export const activeSegmentClasses = 'bg-surface-100 text-ink shadow-card max-narrow:hidden';
/** The track the two segments sit in; the title before it takes the room, so it sits at the right. */
export const segmentTrackClasses =
  'flex shrink-0 gap-1 rounded-lg bg-surface-200 p-1 max-narrow:bg-transparent max-narrow:p-0';

/** The glyph at the head of a header: what this screen is, quiet beside its name (D-110). */
export const HeaderTile = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <span aria-hidden="true" className="inline-flex shrink-0 text-ink-subtle max-narrow:hidden">
    {children}
  </span>
);

/** What a person calls this channel: its name, or who they are talking to. */
export const useChannelTitle = (channel: Channel): string => {
  const { t } = useI18n();
  const { user } = useSession();
  if (channel.type !== 'direct_message') return channel.name ?? '';
  const peer = channel.peer;
  // A group is its people, by name (D-127).
  if (peer === null) {
    return channel.peers.length > 0
      ? channel.peers.map((person) => nameOf(person, t('user.erased'))).join(', ')
      : (channel.name ?? '');
  }
  // A person is named by their name, as the sidebar names them; the handle is their profile's.
  const name = nameOf(peer, t('user.erased'));
  return peer.id === user.id ? t('feed.selfDm', { name }) : name;
};

export const ChannelHeader = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const { t, format } = useI18n();
  const { workspace } = useWorkspace();
  const { user: me } = useSession();
  const title = useChannelTitle(channel);
  // This channel's open questions, not the workspace's: the number beside its name is its own.
  const open = useOpenCount(workspace.id, channel.id);
  const direct = channel.type === 'direct_message';
  // A member brings people in (D-104); a direct message is between its two people.
  const canAdd = !direct && channel.state !== null;
  const [adding, setAdding] = useState(false);
  const [details, setDetailsOpen] = useState(false);
  const [detailsOpened, setDetailsOpened] = useState(false);
  const setDetails = (open: boolean): void => {
    if (open) setDetailsOpened(true);
    setDetailsOpen(open);
  };
  const group = direct && channel.peers.length >= 2;
  // Adding people and a group's details are in the deferred chunk (D-163).
  const deferred = useDeferred([adding, setAdding], [group && details, setDetailsOpen]);
  const peerOnline = useOnline(channel.peer?.id ?? '', me.id);
  const openText =
    open !== null && open.count > 0 ? `${format.number(open.count)}${open.more ? '+' : ''}` : null;
  const questionsName =
    openText === null ? t('header.questions') : `${t('header.questions')} ${openText}`;

  return (
    <header className="flex h-header shrink-0 items-center gap-3 border-b-hairline max-narrow:gap-1 border-border-subtle pr-4 pl-6 max-narrow:pl-4">
      <div data-header-title="" className="flex min-w-0 flex-1 items-center gap-2">
        <NavToggle />
        {direct && channel.peer !== null ? (
          <Avatar
            name={nameOf(channel.peer, t('user.erased'))}
            username={channel.peer.username}
            size="sm"
            online={peerOnline}
          />
        ) : group ? (
          // A group shows the faces it is named by, as its sidebar row does (D-167).
          <GroupFace peers={channel.peers} surface="surface" />
        ) : (
          <HeaderTile>
            <Icon
              name={direct ? 'person' : channel.type === 'private' ? 'private-channel' : 'channel'}
            />
          </HeaderTile>
        )}
        {group ? (
          <>
            {/* A group's people open its details (D-127); a conversation of two has none. */}
            <h1 className="min-w-0 truncate text-title text-ink">
              <button
                type="button"
                className="max-w-full truncate rounded-sm hover:text-accent-text"
                onClick={() => {
                  setDetails(true);
                }}
              >
                {title}
              </button>
            </h1>
            {deferred !== null && (
              <deferred.GroupDetailsDialog
                channel={channel}
                title={title}
                open={details}
                onOpenChange={setDetails}
              />
            )}
          </>
        ) : direct && channel.peer !== null ? (
          <>
            <PeerHeading peer={channel.peer} title={title} />
            {/* The dot is the avatar's, which a screen reader skips: said here instead (D-136). */}
            {peerOnline === true && <VisuallyHidden>{t('presence.online')}</VisuallyHidden>}
          </>
        ) : direct ? (
          <h1 className="min-w-0 truncate text-title text-ink">{title}</h1>
        ) : (
          <>
            {/* The name opens the channel's details (D-123); the heading's name stays the channel's. */}
            <h1 className="min-w-0 truncate text-title text-ink">
              <button
                type="button"
                className="max-w-full truncate rounded-sm hover:text-accent-text"
                onClick={() => {
                  setDetails(true);
                }}
              >
                {title}
              </button>
            </h1>
            {/* The star is the channel's own, beside its name where Slack and Linear keep it, not one
                more icon in the cluster of actions on the right. */}
            <StarToggle channel={channel} />
            {/* Said by name to a screen reader; the composer below says what it means (D-243). */}
            {channel.onlyAdminsPost && (
              <span className="inline-flex shrink-0 text-ink-subtle">
                <Icon name="announcement" size="sm" label={t('header.announcement')} />
              </span>
            )}
            <span
              aria-hidden="true"
              className="h-4 shrink-0 border-l-hairline border-border-subtle max-narrow:hidden"
            />
            {/* The topic is part of the same target for a pointer; a key reaches it by the name. */}
            <button
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              className="min-w-0 flex-1 basis-0 truncate text-left text-label text-ink-muted hover:text-ink max-narrow:hidden"
              onClick={() => {
                setDetails(true);
              }}
            >
              {channel.topic ?? t('header.noTopic')}
            </button>
            {detailsOpened && (
              <Suspense fallback={null}>
                <ChannelDetailsDialog channel={channel} open={details} onOpenChange={setDetails} />
              </Suspense>
            )}
          </>
        )}
      </div>
      {/* A channel always offers its open questions — they are the product's argument; a
      conversation only while it has some, where an empty view would be one more control. */}
      {(!direct || openText !== null) && (
        <nav aria-label={t('header.views')} className={segmentTrackClasses}>
          <Link
            to="channel"
            params={{ slug: workspace.slug, channelId: channel.id }}
            aria-current="page"
            className={cn(segmentClasses, activeSegmentClasses)}
          >
            {t('header.feed')}
          </Link>
          <Link
            to="questions"
            params={{ slug: workspace.slug }}
            search={narrowedTo(channel.id)}
            aria-label={questionsName}
            className={cn(segmentClasses, 'text-ink-muted')}
          >
            {/* On a narrow window the glyph stands for the words, which the link's name still says:
          a phone's width cannot give them room and keep the channel's name readable (#624). */}
            <span aria-hidden="true" className="hidden max-narrow:inline-flex">
              <Icon name="open-question" />
            </span>
            <span className="max-narrow:hidden">{t('header.questions')}</span>
            {/* A space the eye does not need but the text does: what is shown reads as its name. */}
            {openText !== null && ' '}
            {openText !== null && (
              <span className="font-mono text-caption text-warning-text">{openText}</span>
            )}
          </Link>
        </nav>
      )}
      {/* What the header does, in one group at one spacing: the panels it opens, then how this
          channel notifies and who is in it, set apart by a hairline. */}
      <div className="flex shrink-0 items-center gap-1 max-narrow:gap-0">
        <PanelControls direct={direct} channel={channel} />
        <span
          aria-hidden="true"
          className="mx-1 h-4 shrink-0 border-l-hairline border-border-subtle max-narrow:hidden"
        />
        <NotificationLevelMenu channel={channel} />
        {canAdd && (
          <>
            <IconButton
              label={t('people.add')}
              glyph="add"
              onClick={() => {
                setAdding(true);
              }}
            />
            {deferred !== null && (
              <deferred.AddPeopleDialog channel={channel} open={adding} onOpenChange={setAdding} />
            )}
          </>
        )}
      </div>
    </header>
  );
};
