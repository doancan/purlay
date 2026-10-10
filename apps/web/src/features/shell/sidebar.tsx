/** The sidebar. A stand-in the sidebar slice replaces: the workspace's name and nothing else. */
import { useI18n } from '../../i18n/i18n-provider';
import { useWorkspace } from './workspace';

export const Sidebar = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  return (
    <aside
      aria-label={t('sidebar.label')}
      className="flex w-sidebar shrink-0 flex-col gap-4 border-r-hairline border-border-subtle bg-surface-000 px-2 py-3"
    >
      <span className="px-3 text-heading text-ink">{workspace.name}</span>
    </aside>
  );
};
