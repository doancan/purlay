/**
 * The sidebar card (`UX.md` §2, D-100): the workspace, the way into the palette, the one view that
 * is the product's argument, the channels, the people, and — at the foot — who you are and the two
 * settings a person actually reaches for, the theme and the language.
 *
 * A floating card on the canvas, `w-sidebar` wide; sections scroll together when there are more
 * channels than the window is tall, and the header and footer do not. Each section owns its own
 * loading, failure and empty state (`features/sidebar/*`), so a channel list that cannot load
 * does not take the people or the header with it. Inside the narrow window's overlay it is the
 * whole panel, so it drops the card's corners and shadow: the dialog is the surface there.
 */
import { LanguageMenu } from '../../i18n/language-menu';
import { useI18n } from '../../i18n/i18n-provider';
import { ThemeMenu } from '../../theme/theme-menu';
import { Avatar } from '../../ui/avatar';
import { cn } from '../../ui/cn';
import { useSession } from '../session/session';
import { ChannelList } from '../sidebar/channel-list';
import { JumpField } from '../sidebar/jump-field';
import { InboxLink } from '../inbox/inbox-link';
import { SearchLink } from '../search/search-link';
import { OpenQuestionsLink } from '../sidebar/open-questions-link';
import { PeopleList } from '../sidebar/people-list';
import { WorkspaceMenu } from '../sidebar/workspace-menu';

interface SidebarProps {
  /** Inside the narrow window's overlay: as tall as the panel rather than as tall as the page's row. */
  readonly overlay?: boolean;
}

export const Sidebar = ({ overlay = false }: SidebarProps): React.JSX.Element => {
  const { t } = useI18n();
  const { user } = useSession();
  return (
    <aside
      aria-label={t('sidebar.label')}
      className={cn(
        'flex w-sidebar shrink-0 flex-col gap-3 bg-surface-100 p-3',
        overlay ? 'h-full' : 'rounded-lg shadow-card',
      )}
    >
      <WorkspaceMenu />
      <JumpField />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        <div className="flex flex-col gap-1">
          <OpenQuestionsLink />
          <InboxLink />
          <SearchLink />
        </div>
        <ChannelList />
        <PeopleList />
      </div>
      <footer className="flex items-center justify-between gap-2 border-t-hairline border-border-subtle pt-3">
        <p className="flex min-w-0 items-center gap-2 text-body text-ink">
          <Avatar size="sm" name={user.displayName} username={user.username} />
          <span className="truncate">{user.displayName}</span>
        </p>
        <div className="flex">
          <ThemeMenu />
          <LanguageMenu />
        </div>
      </footer>
    </aside>
  );
};
