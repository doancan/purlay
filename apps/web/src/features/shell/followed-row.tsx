/** Followed conversations stay discoverable beside All unreads in the channel sidebar. */
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { Link, useRoute } from '../../router/router-provider';
import { cn } from '../../ui/cn';
import { navMarkerClasses } from '../../ui/nav-row';
import { useWorkspace } from './workspace';

export const FollowedRow = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const current = useRoute().match.name === 'followed';
  return (
    <Link
      to="followed"
      params={{ slug: workspace.slug }}
      aria-current={current ? 'page' : undefined}
      className={cn(
        'flex h-row items-center gap-2 rounded-lg px-2 text-body transition-colors duration-hover ease-standard max-narrow:h-touch',
        // Bold in this column means something waits, and this row is there whether or not anything does: at rest it
        // is in a read channel's quiet tone, and in weight only where you are.
        current
          ? 'relative bg-nav-selected font-semibold text-nav-ink [&>svg]:text-accent-text'
          : 'text-nav-ink-muted hover:bg-nav-hover hover:text-nav-ink',
        current && navMarkerClasses,
      )}
    >
      <Icon name="notifications" />
      <span className="min-w-0 flex-1 truncate">{t('followed.title')}</span>
    </Link>
  );
};
