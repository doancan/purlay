/**
 * The sidebar (`UX.md` §2, D-110): the workspace's name, which opens the workspace menu, the way into the palette, the channels,
 * the people, and — at the foot — who you are, which opens the account menu (D-124).
 *
 * Flat, `w-sidebar` wide, in the navigation tone it shares with the rail, and divided from the
 * conversation by one hairline. Sections scroll together when there are more channels than the
 * window is tall; the header and footer do not. Each section owns its own loading, failure and
 * empty state (`features/chat/sidebar/*`), so a channel list that cannot load does not take the people
 * or the header with it. Inside the narrow window's overlay it is the panel beside the rail, so
 * it drops the hairline: the dialog is the edge there.
 */
import { useI18n } from '../../i18n/i18n-provider';
import { cn } from '../../ui/cn';
import { ChannelSections } from '../chat/sidebar/channel-list';
import { UnreadsRow } from '../chat/unreads/unreads-row';
import { FollowedRow } from './followed-row';
import { ConversationList } from '../chat/sidebar/conversation-list';
import { JumpField } from '../chat/sidebar/jump-field';
import { PeopleList } from '../chat/sidebar/people-list';
import { SidebarOptions } from '../chat/sidebar/sidebar-options';
import { SidebarPreferencesProvider } from '../chat/sidebar/preferences-context';
import { useSession } from '../session/session';
import { useWorkspace } from './workspace';
import { WorkspaceMenu } from '../chat/sidebar/workspace-menu';
import { useRoute } from '../../router/router-provider';
import { LazySettingsNav } from '../settings/load';
import { AccountMenu } from './account-menu';
import { WhenRun } from './module-gate';

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
      {settings ? (
        <LazySettingsNav />
      ) : (
        // Remounted for each person and workspace, so one's folds are never drawn in another (D-195).
        <SidebarPreferencesProvider
          key={`${user.id}.${workspace.id}`}
          userId={user.id}
          workspaceId={workspace.id}
        >
          {/* The workspace's band is as tall as the header beside it and ends on the same line, so the
              first row of the sidebar and the first row of the screen read as one. */}
          <div className="flex h-header shrink-0 items-center gap-1 border-b-hairline border-nav-border px-2">
            <WorkspaceMenu />
            <SidebarOptions />
          </div>
          <WhenRun module="chat">
            <div className="px-2 py-3">
              <JumpField />
            </div>
          </WhenRun>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-4">
            <WhenRun module="chat">
              {/* One rhythm down the column: rows 4px apart inside a group, 12px between groups, so a section's
                  name sits nearer its own rows than the rows above it. */}
              <div className="flex flex-col gap-3 pt-1 pb-3">
                <div className="flex flex-col gap-1">
                  <UnreadsRow />
                  <FollowedRow />
                </div>
                <ChannelSections />
              </div>
              {/* A section switched off draws nothing, and its divider goes with it rather than doubling the next. */}
              <div className="border-t-hairline border-nav-border py-3 empty:hidden">
                <ConversationList />
              </div>
            </WhenRun>
            <div className="border-t-hairline border-nav-border py-3 empty:hidden">
              <PeopleList />
            </div>
          </div>
        </SidebarPreferencesProvider>
      )}
      {/* Inset as the rows above it are, so the avatar stands in the column of their glyphs. */}
      <footer className="shrink-0 border-t-hairline border-nav-border p-2">
        <AccountMenu />
      </footer>
    </aside>
  );
};
