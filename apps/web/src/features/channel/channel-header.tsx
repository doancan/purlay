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

/** One segment of the header's two-way control: the feed, or the open questions. */
export const segmentClasses =
  'inline-flex h-control items-center gap-2 whitespace-nowrap rounded-pill px-3 text-label hover:text-ink max-narrow:h-touch';
/** The segment the person is on: raised out of the track, bordered rather than shadowed. */
export const activeSegmentClasses =
  'border-hairline border-border-subtle bg-surface-100 text-ink max-narrow:hidden';
/** The track the two segments sit in. */
export const segmentTrackClasses =
  'flex shrink-0 gap-1 rounded-pill bg-surface-200 p-1 max-narrow:bg-transparent max-narrow:p-0';

/** The square at the head of a header: what this screen is, in a glyph. */
export const HeaderTile = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <span
    aria-hidden="true"
    className="inline-flex size-avatar-lg shrink-0 items-center justify-center rounded-md bg-surface-200 text-ink-muted max-narrow:hidden"
  >
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

  return (
    <header className="flex h-header shrink-0 items-center justify-between gap-4 border-b-hairline border-border-subtle px-4">
      <div className="flex min-w-0 items-center gap-2">
        <NavToggle />
        {direct && channel.peer !== null ? (
          <Avatar name={channel.peer.displayName} username={channel.peer.username} size="lg" />
        ) : (
          <HeaderTile>
            <Icon name={direct ? 'person' : 'channel'} size="lg" />
          </HeaderTile>
        )}
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate font-mono text-title text-ink">{title}</h1>
          {!direct && (
            <span className="truncate text-caption text-ink-muted max-narrow:hidden">
              {channel.topic ?? t('header.noTopic')}
            </span>
          )}
        </div>
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
            <span className="font-mono text-warning-text">
              {format.number(open.count)}
              {open.more && '+'}
            </span>
          )}
        </Link>
      </nav>
    </header>
  );
};
