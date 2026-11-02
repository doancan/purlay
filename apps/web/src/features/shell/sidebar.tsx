/**
 * The sidebar (`UX.md` §2, D-110): the workspace's name, which opens the workspace menu, the way into the palette, the channels,
 * the people, and — at the foot — who you are, which opens the account menu (D-124).
 *
 * Flat, `w-sidebar` wide, in the navigation tone it shares with the rail, and divided from the
 * conversation by one hairline. Sections scroll together when there are more channels than the
 * window is tall; the header and footer do not. Each section owns its own loading, failure and
 * empty state (`features/sidebar/*`), so a channel list that cannot load does not take the people
 * or the header with it. Inside the narrow window's overlay it is the panel beside the rail, so
 * it drops the hairline: the dialog is the edge there.
 */
import { useI18n } from '../../i18n/i18n-provider';
import { cn } from '../../ui/cn';
import { ChannelList } from '../sidebar/channel-list';
import { StarredList } from '../sidebar/starred-list';
import { UnreadsRow } from '../unreads/unreads-row';
import { ConversationList } from '../sidebar/conversation-list';
import { JumpField } from '../sidebar/jump-field';
import { PeopleList } from '../sidebar/people-list';
import { SidebarOptions } from '../sidebar/sidebar-options';
import { SidebarPreferencesProvider } from '../sidebar/preferences-context';
import { useSession } from '../session/session';
import { useWorkspace } from './workspace';
import { WorkspaceMenu } from '../sidebar/workspace-menu';
import { useRoute } from '../../router/router-provider';
import { LazySettingsNav } from '../settings/load';
import { AccountMenu } from './account-menu';

interface SidebarProps {
  /** Inside the narrow window's overlay: as tall as the panel rather than as tall as the page's row. */
  readonly overlay?: boolean;
}

export const Sidebar = ({ overlay = false }: SidebarProps): React.JSX.Element => {
  const { t } = useI18n();
  const { match } = useRoute();
  const { user } = useSession();
  const { workspace } = useWorkspace();
  // While a settings page is open, the column lists the settings' pages instead (D-146).
  const settings = match.name === 'settings' || match.name === 'settingsHome';
  return (
    <aside
      aria-label={t('sidebar.label')}
      className={cn(
        'flex w-sidebar shrink-0 flex-col bg-nav-surface',
        overlay ? 'h-full' : 'border-r-hairline border-nav-border',
      )}
    >
      <div className="h-drag shrink-0" />
      {settings ? (
        <LazySettingsNav />
      ) : (
        // Remounted for each person and workspace, so one's folds are never drawn in another (D-195).
        <SidebarPreferencesProvider
          key={`${user.id}.${workspace.id}`}
          userId={user.id}
          workspaceId={workspace.id}
        >
          {/* The workspace's card (D-209) is taller than a row: room below it, so the jump field under it
              reads as the next thing and not as part of the card. */}
          <div className="flex shrink-0 items-center gap-1 px-2 pt-1 pb-3">
            <WorkspaceMenu />
            <SidebarOptions />
          </div>
          <div className="px-2 pb-3">
            <JumpField />
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-4">
            <div className="pt-1 pb-3">
              <UnreadsRow />
              <StarredList />
              <ChannelList />
            </div>
            <div className="border-t-hairline border-nav-border py-3">
              <ConversationList />
            </div>
            <div className="border-t-hairline border-nav-border py-3">
              <PeopleList />
            </div>
          </div>
        </SidebarPreferencesProvider>
      )}
      <footer className="shrink-0 border-t-hairline border-nav-border p-1">
        <AccountMenu />
      </footer>
    </aside>
  );
};
