/**
 * "Search" in the sidebar, under the inbox: the words of every channel the person can see (D-105).
 */
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { Link, useRoute } from '../../router/router-provider';
import { cn } from '../../ui/cn';
import { useWorkspace } from '../shell/workspace';

export const SearchLink = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { match } = useRoute();
  const current = match.name === 'search';
  return (
    <Link
      to="search"
      params={{ slug: workspace.slug }}
      {...(current ? { 'aria-current': 'page' as const } : {})}
      className={cn(
        'flex h-control shrink-0 items-center gap-2 rounded-md px-2 text-body text-ink max-narrow:h-touch hover:bg-surface-200',
        current && 'bg-accent-subtle font-medium hover:bg-accent-subtle',
      )}
    >
      <span className="text-ink-muted">
        <Icon name="search" />
      </span>
      <span className="flex-1">{t('search.title')}</span>
    </Link>
  );
};
