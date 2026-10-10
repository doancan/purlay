/**
 * "Open questions", the first thing in the sidebar — the product's argument in one line
 * (`UX.md` §4.4): how many threads somebody asked about and nobody has finished.
 *
 * The count is read from the open-questions query itself, so resolving a thread anywhere
 * changes it with no code here: the cache's thread update re-asks that query, and this
 * re-renders. It is plain text, not a badge — a badge is for what needs *you*, and an open
 * question belongs to the whole team. Nothing is drawn while it loads or fails (a wrong
 * zero would be worse than none); the link is there either way.
 */
import { Icon } from '../../components/icon';
import { useUnresolved } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { useRoute } from '../../router/router-provider';
import { Link } from '../../router/router-provider';
import { cn } from '../../ui/cn';
import { useWorkspace } from '../shell/workspace';
import { shownQuestionCount } from './ordering';

export const OpenQuestionsLink = (): React.JSX.Element => {
  const { t, format } = useI18n();
  const { workspace } = useWorkspace();
  const { match } = useRoute();
  const unresolved = useUnresolved(workspace.id);
  const current = match.name === 'questions';
  const loaded = unresolved.data?.pages.reduce((sum, page) => sum + page.data.length, 0) ?? 0;
  const known = unresolved.isSuccess;
  const { count, over } = shownQuestionCount(loaded, unresolved.hasNextPage);

  return (
    <Link
      to="questions"
      params={{ slug: workspace.slug }}
      {...(current ? { 'aria-current': 'page' as const } : {})}
      className={cn(
        'flex h-control items-center gap-2 rounded-md px-3 text-body text-ink max-narrow:h-touch hover:bg-surface-200',
        current && 'bg-surface-200 font-medium',
      )}
    >
      <span className="text-warning-text">
        <Icon name="open-question" />
      </span>
      <span className="flex-1">{t('sidebar.questions')}</span>
      {known && loaded > 0 ? (
        <span className="font-mono text-label text-ink-muted">
          {over ? t('sidebar.questions.many') : format.number(count)}
        </span>
      ) : null}
    </Link>
  );
};
