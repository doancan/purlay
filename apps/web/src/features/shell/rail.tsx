/**
 * The rail: the places you go, down the window's left edge (D-110).
 *
 * The workspace is not on it: its mark and name head the sidebar beside it, the one door to the
 * workspace menu (D-206). Every entry is a route or a menu that exists without the rail — it adds
 * no destination. At its foot a gear opens Settings (D-146), which the account menu and the palette also open. Its top
 * is an empty strip the desktop shell will draw its window controls over (D-14). Below the narrow
 * breakpoint it is not in the layout: it opens with the sidebar, in the same overlay.
 */
import { useI18n } from '../../i18n/i18n-provider';
import { Link, useRoute } from '../../router/router-provider';
import { Tooltip } from '../../ui/tooltip';
import { InboxLink } from '../inbox/inbox-link';
import { SavedLink } from '../saved/saved-link';
import { DraftsLink } from '../drafts/drafts-link';
import { SearchLink } from '../search/search-link';
import { OpenQuestionsLink } from '../sidebar/open-questions-link';
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
        // A section, not the page itself: the open channel's row, or the settings page, is the page,
        // and two links that both say "current page" leave a screen reader unsure which.
        {...(current ? { 'aria-current': 'true' as const } : {})}
        className={railItemClasses(current)}
      >
        <RailItemContent glyph="channels" label={t('sidebar.channels')} />
      </Link>
    </Tooltip>
  );
};

/** Settings (D-146): the person's Profile page first, the workspace's pages beside it. */
const SettingsLink = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { match } = useRoute();
  const current = match.name === 'settings' || match.name === 'settingsHome';
  return (
    <Tooltip content={t('settings.label')} side="right">
      <Link
        to="settingsHome"
        params={{ slug: workspace.slug }}
        // A section, not the page itself: the open channel's row, or the settings page, is the page,
        // and two links that both say "current page" leave a screen reader unsure which.
        {...(current ? { 'aria-current': 'true' as const } : {})}
        className={railItemClasses(current)}
      >
        <RailItemContent glyph="settings" label={t('settings.label')} />
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
      className={
        overlay
          ? 'flex h-full w-rail shrink-0 flex-col items-center bg-nav-rail pb-4'
          : 'flex w-rail shrink-0 flex-col items-center border-r-hairline border-nav-border bg-nav-rail pb-4'
      }
    >
      <div className="h-drag w-full shrink-0" />
      {/* The first place sits level with the workspace's name in the sidebar's header. */}
      <div className="flex flex-col items-center gap-4 pt-1">
        <ChannelsLink />
        <InboxLink />
        <OpenQuestionsLink />
        <SearchLink />
        <SavedLink />
        <DraftsLink />
      </div>
      <div className="mt-auto">
        <SettingsLink />
      </div>
    </nav>
  );
};
