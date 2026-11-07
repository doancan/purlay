/** Followed conversations stay discoverable beside All unreads in the channel sidebar. */
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { Link, useRoute } from '../../router/router-provider';
import { cn } from '../../ui/cn';
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
        'flex h-row items-center gap-2 rounded-lg px-2 text-body font-semibold text-nav-ink transition-colors duration-hover ease-standard max-narrow:h-touch',
        current ? 'bg-nav-selected [&>svg]:text-accent-text' : 'hover:bg-nav-hover',
      )}
    >
      <Icon name="notifications" />
      <span className="min-w-0 flex-1 truncate">{t('followed.title')}</span>
    </Link>
  );
};
