/**
 * The sidebar (`UX.md` §2): the workspace, the one view that is the product's argument,
 * the channels, the people, and — at the foot — who you are and the two settings a person
 * actually reaches for, the theme and the language.
 *
 * Fixed at `w-sidebar`, on `surface-000` so it recedes behind the feed; sections scroll
 * together when there are more channels than the window is tall, and the footer does not.
 * Each section owns its own loading, failure and empty state (`features/sidebar/*`), so a
 * channel list that cannot load does not take the people or the header with it.
 */
import { LanguageMenu } from '../../i18n/language-menu';
import { useI18n } from '../../i18n/i18n-provider';
import { ThemeMenu } from '../../theme/theme-menu';
import { cn } from '../../ui/cn';
import { Kbd } from '../../ui/kbd';
import { useSession } from '../session/session';
import { ChannelList } from '../sidebar/channel-list';
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
        'flex w-sidebar shrink-0 flex-col gap-4 border-r-hairline border-border-subtle bg-surface-000 px-2 py-3',
        overlay && 'h-full',
      )}
    >
      <WorkspaceMenu />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        <OpenQuestionsLink />
        <ChannelList />
        <PeopleList />
      </div>
      <footer className="flex items-center justify-between gap-2 px-3">
        <p className="min-w-0 text-caption text-ink-muted">
          <span className="block truncate text-ink">{user.displayName}</span>
          <Kbd>⌘K</Kbd> {t('sidebar.jump')}
        </p>
        <div className="flex">
          <ThemeMenu />
          <LanguageMenu />
        </div>
      </footer>
    </aside>
  );
};
