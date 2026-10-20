/**
 * The settings' navigation, in the sidebar's place while a settings page is open (D-146).
 *
 * The way back to the conversation first, then the person's pages and — for whoever may open them —
 * the workspace's, from `SETTINGS_SECTIONS`. Rows are the sidebar's rows (32px, the navigation tone,
 * the accent for where you are), so moving into settings changes what the column lists and not how
 * it looks.
 */
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { Link, useRoute } from '../../router/router-provider';
import { cn } from '../../ui/cn';
import { useWorkspace } from '../shell/workspace';
import { FIRST_SECTION, sectionsFor, type SettingsSection } from './sections';
import { useWorkspaceRole } from './role';

const rowClasses =
  'flex h-row w-full items-center gap-2 rounded-lg px-2 text-body transition-colors duration-hover ease-standard max-narrow:h-touch';

const Group = ({
  title,
  sections,
  current,
}: {
  readonly title: string;
  readonly sections: readonly SettingsSection[];
  readonly current: string | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  if (sections.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 pt-4">
      <h2 className="px-2 py-1 text-label text-nav-ink-muted">{title}</h2>
      <ul className="flex flex-col gap-1">
        {sections.map((section) => {
          const here = section.id === current;
          return (
            <li key={section.id}>
              <Link
                to="settings"
                params={{ slug: workspace.slug, section: section.id }}
                {...(here ? { 'aria-current': 'page' as const } : {})}
                className={cn(
                  rowClasses,
                  here
                    ? 'bg-accent font-medium text-on-accent'
                    : 'text-nav-ink-muted hover:bg-nav-hover hover:text-nav-ink',
                )}
              >
                <Icon name={section.glyph} />
                <span className="min-w-0 flex-1 truncate">{t(`settings.${section.id}.nav`)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export const SettingsNav = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { match } = useRoute();
  const role = useWorkspaceRole();
  const current =
    match.name === 'settings'
      ? match.params.section
      : match.name === 'settingsHome'
        ? FIRST_SECTION
        : null;
  const sections = sectionsFor(role);
  return (
    <>
      <div className="flex flex-col gap-1 px-4 pt-3 pb-2">
        <h1 className="text-title text-nav-ink">{t('settings.title')}</h1>
      </div>
      <nav
        aria-label={t('settings.title')}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-4"
      >
        <Link
          to="workspace"
          params={{ slug: workspace.slug }}
          className={cn(rowClasses, 'text-nav-ink-muted hover:bg-nav-hover hover:text-nav-ink')}
        >
          <Icon name="back" />
          <span className="min-w-0 flex-1 truncate">
            {t('settings.back', { workspace: workspace.name })}
          </span>
        </Link>
        <Group
          title={t('settings.group.account')}
          sections={sections.filter((section) => section.group === 'account')}
          current={current}
        />
        <Group
          title={t('settings.group.workspace', { workspace: workspace.name })}
          sections={sections.filter((section) => section.group === 'workspace')}
          current={current}
        />
      </nav>
    </>
  );
};
