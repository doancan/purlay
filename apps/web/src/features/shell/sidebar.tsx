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
      className={cn(
        'flex w-sidebar shrink-0 flex-col bg-surface-000',
        overlay ? 'h-full' : 'border-r-hairline border-border-subtle',
      )}
    >
      <div className="h-drag shrink-0" />
      <p className="truncate px-4 pt-2 pb-3 text-title text-ink">{workspace.name}</p>
      <div className="px-3 pb-3">
        <JumpField />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 pb-4">
        <ChannelList />
        <PeopleList />
      </div>
      <footer className="flex items-center gap-2 border-t-hairline border-border-subtle px-4 py-3">
        <Avatar size="md" name={user.displayName} username={user.username} />
        <div className="min-w-0">
          <p className="truncate text-label text-ink">{user.displayName}</p>
          <p className="truncate font-mono text-caption text-ink-subtle">{`@${user.username}`}</p>
        </div>
      </footer>
    </aside>
  );
};
