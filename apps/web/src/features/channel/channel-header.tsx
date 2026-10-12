/**
 * The channel's header: its name, what it is for, and the two ways to look at it —
 * the feed and the workspace's open questions, with their live count (`UX.md` §2, §4.4).
 *
 * A channel's name is set in the mono face with a `#`, like the sidebar's (the approved
 * prototype's choice: this is where code gets pasted). A direct message has no name, so it
 * shows the other person; a note to oneself says so. The count beside "Open questions" is
 * the same number the sidebar shows and comes from the same cache entry
 * (`use-open-count.ts`), so the two cannot differ.
 */
import { useState } from 'react';
import type { Channel } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { Link } from '../../router/router-provider';
import { Avatar } from '../../ui/avatar';
import { cn } from '../../ui/cn';
import { useOpenCount } from '../questions/use-open-count';
import { NavToggle } from '../shell/nav';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';
import { IconButton } from '../../ui/icon-button';
import { AddPeopleDialog } from './add-people';
import { NotificationLevelMenu } from './notification-level-menu';

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
  if (peer === null) return channel.name ?? '';
  return peer.id === user.id ? t('feed.selfDm', { name: peer.username }) : peer.username;
};

export const ChannelHeader = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const { t, format } = useI18n();
  const { workspace } = useWorkspace();
  const title = useChannelTitle(channel);
  const open = useOpenCount(workspace.id);
  const direct = channel.type === 'direct_message';
  // A member brings people in (D-104); a direct message is between its two people.
  const canAdd = !direct && channel.state !== null;
  const [adding, setAdding] = useState(false);

  return (
    <header className="flex h-header shrink-0 items-center gap-3 border-b-hairline border-border-subtle px-4">
      <div data-header-title="" className="flex min-w-0 flex-1 items-center gap-2">
        <NavToggle />
        {direct && channel.peer !== null ? (
          <Avatar name={channel.peer.displayName} username={channel.peer.username} size="sm" />
        ) : (
          <HeaderTile>
            <Icon
              name={direct ? 'person' : channel.type === 'private' ? 'private-channel' : 'channel'}
            />
          </HeaderTile>
        )}
        <h1 className="shrink-0 truncate text-title text-ink">{title}</h1>
        {!direct && (
          <>
            <span
              aria-hidden="true"
              className="h-4 shrink-0 border-l-hairline border-border-subtle max-narrow:hidden"
            />
            <span className="truncate text-label text-ink-muted max-narrow:hidden">
              {channel.topic ?? t('header.noTopic')}
            </span>
          </>
        )}
      </div>
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
          className={cn(segmentClasses, 'text-ink-muted')}
        >
          {t('header.questions')}
          {open !== null && open.count > 0 && (
            <span className="font-mono text-caption text-warning-text">
              {format.number(open.count)}
              {open.more && '+'}
            </span>
          )}
        </Link>
      </nav>
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
          <AddPeopleDialog channel={channel} open={adding} onOpenChange={setAdding} />
        </>
      )}
    </header>
  );
};
