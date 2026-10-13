/**
 * The sidebar (`UX.md` §2, D-110): the workspace's name, the way into the palette, the channels,
 * the people, and — at the foot — who you are.
 *
 * Flat, `w-sidebar` wide, in the navigation tone it shares with the rail, and divided from the
 * conversation by one hairline. Sections scroll together when there are more channels than the
 * window is tall; the header and footer do not. Each section owns its own loading, failure and
 * empty state (`features/sidebar/*`), so a channel list that cannot load does not take the people
 * or the header with it. Inside the narrow window's overlay it is the panel beside the rail, so
 * it drops the hairline: the dialog is the edge there.
 */
import { useI18n } from '../../i18n/i18n-provider';
import { Avatar } from '../../ui/avatar';
import { cn } from '../../ui/cn';
import { useSession } from '../session/session';
import { ChannelList } from '../sidebar/channel-list';
import { JumpField } from '../sidebar/jump-field';
import { PeopleList } from '../sidebar/people-list';
import { useWorkspace } from './workspace';

interface SidebarProps {
  /** Inside the narrow window's overlay: as tall as the panel rather than as tall as the page's row. */
  readonly overlay?: boolean;
}

export const Sidebar = ({ overlay = false }: SidebarProps): React.JSX.Element => {
  const { t } = useI18n();
  const { user } = useSession();
  const { workspace } = useWorkspace();
  return (
    <aside
      aria-label={t('sidebar.label')}
      // Navigation is drawn in the dark theme whatever the page's (D-118).
      data-theme="dark"
      className={cn(
        'flex w-sidebar shrink-0 flex-col bg-nav-surface',
        overlay ? 'h-full' : 'border-r-hairline border-nav-border',
      )}
    >
      <div className="h-drag shrink-0" />
      <p className="truncate px-4 py-3 text-title text-nav-ink">{workspace.name}</p>
      <div className="px-3 pb-3">
        <JumpField />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-4">
        <div className="pt-1 pb-3">
          <ChannelList />
        </div>
        <div className="border-t-hairline border-nav-border py-3">
          <PeopleList />
        </div>
      </div>
      <footer className="flex shrink-0 items-center gap-3 border-t-hairline border-nav-border px-3 py-3">
        <Avatar size="md" name={user.displayName} username={user.username} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-label font-semibold text-nav-ink">{user.displayName}</p>
          <p className="truncate font-mono text-caption text-nav-ink-muted">{`@${user.username}`}</p>
        </div>
      </footer>
    </aside>
  );
};
