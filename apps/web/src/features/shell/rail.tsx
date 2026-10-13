/**
 * The rail: the workspace and the places you go, down the window's left edge (D-110). What is the
 * person's own — theme, language, the shortcut reference — is in the account menu at the sidebar's
 * foot (D-124), not on a gear here.
 *
 * Every entry is a route or a menu that exists without the rail — it adds no destination. Its top
 * is an empty strip the desktop shell will draw its window controls over (D-14). Below the narrow
 * breakpoint it is not in the layout: it opens with the sidebar, in the same overlay.
 */
import { useI18n } from '../../i18n/i18n-provider';
import { Link, useRoute } from '../../router/router-provider';
import { Tooltip } from '../../ui/tooltip';
import { InboxLink } from '../inbox/inbox-link';
import { SearchLink } from '../search/search-link';
import { OpenQuestionsLink } from '../sidebar/open-questions-link';
import { WorkspaceMenu } from '../sidebar/workspace-menu';
import { RailItemContent, railItemClasses } from './rail-item';
import { useWorkspace } from './workspace';

/** The conversations: the workspace's front door, which opens the channel you were last in. */
const ChannelsLink = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { match } = useRoute();
  const current = match.name === 'channel' || match.name === 'workspace';
  return (
    <Tooltip content={t('sidebar.channels')} side="right">
      <Link
        to="workspace"
        params={{ slug: workspace.slug }}
        {...(current ? { 'aria-current': 'page' as const } : {})}
        className={railItemClasses(current)}
      >
        <RailItemContent glyph="channels" label={t('sidebar.channels')} />
      </Link>
    </Tooltip>
  );
};

interface RailProps {
  /** Inside the narrow window's overlay: as tall as the panel. */
  readonly overlay?: boolean;
}

export const Rail = ({ overlay = false }: RailProps): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <nav
      aria-label={t('rail.label')}
      // Navigation is drawn in the dark theme whatever the page's (D-118).
      data-theme="dark"
      className={
        overlay
          ? 'flex h-full w-rail shrink-0 flex-col items-center bg-nav-rail pb-4'
          : 'flex w-rail shrink-0 flex-col items-center border-r-hairline border-nav-border bg-nav-rail pb-4'
      }
    >
      <div className="h-drag w-full shrink-0" />
      <div className="mt-4 mb-6">
        <WorkspaceMenu />
      </div>
      <div className="flex flex-col items-center gap-4">
        <ChannelsLink />
        <InboxLink />
        <OpenQuestionsLink />
        <SearchLink />
      </div>
    </nav>
  );
};
