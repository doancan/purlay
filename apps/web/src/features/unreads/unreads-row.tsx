/**
 * "All unreads" at the head of the sidebar's lists (D-216): there only while a channel waits — a row that
 * leads nowhere new is clutter — with no count of its own; the channels' rows carry theirs (D-110).
 */
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { Link, useRoute } from '../../router/router-provider';
import { Icon } from '../../components/icon';
import { cn } from '../../ui/cn';
import { useWorkspace } from '../shell/workspace';
import { waitingChannels } from './waiting';

export const UnreadsRow = (): React.JSX.Element | null => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { match } = useRoute();
  const channels = useChannels(workspace.id).data ?? [];
  const current = match.name === 'unreads';
  if (!current && waitingChannels(channels).length === 0) return null;
  return (
    <Link
      to="unreads"
      params={{ slug: workspace.slug }}
      {...(current ? { 'aria-current': 'page' as const } : {})}
      className={cn(
        'flex h-row items-center gap-2 rounded-lg px-2 text-body transition-colors duration-hover ease-standard max-narrow:h-touch',
        current
          ? 'bg-nav-selected font-semibold text-nav-ink [&>svg]:text-accent-text'
          : 'font-semibold text-nav-ink hover:bg-nav-hover',
      )}
    >
      <Icon name="channels" />
      <span className="min-w-0 flex-1 truncate">{t('unreads.title')}</span>
    </Link>
  );
};
