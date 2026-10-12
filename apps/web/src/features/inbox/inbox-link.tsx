/**
 * "Inbox" in the sidebar, under the open questions: where the person finds what they were told
 * (D-106). It carries no number of its own — the one numeric badge in the product is a channel's
 * unread mentions (`channel-row.tsx`), and a second count of the same thing would be noise.
 */
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { Link, useRoute } from '../../router/router-provider';
import { cn } from '../../ui/cn';
import { useWorkspace } from '../shell/workspace';

export const InboxLink = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { match } = useRoute();
  const current = match.name === 'inbox';
  return (
    <Link
      to="inbox"
      params={{ slug: workspace.slug }}
      {...(current ? { 'aria-current': 'page' as const } : {})}
      className={cn(
        'flex h-control shrink-0 items-center gap-2 rounded-md px-2 text-body text-ink max-narrow:h-touch hover:bg-surface-200',
        current && 'bg-accent-subtle font-medium hover:bg-accent-subtle',
      )}
    >
      <span className="text-ink-muted">
        <Icon name="notifications" />
      </span>
      <span className="flex-1">{t('inbox.title')}</span>
    </Link>
  );
};
