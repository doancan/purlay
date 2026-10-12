/**
 * "Open questions" on the rail — the product's argument in one place (`UX.md` §4.4): how many
 * threads somebody asked about and nobody has finished.
 *
 * The count is read from the open-questions query itself, so resolving a thread anywhere
 * changes it with no code here: the cache's thread update re-asks that query, and this
 * re-renders. It is a neutral count, not a badge — a badge is for what needs *you*, and an open
 * question belongs to the whole team. Nothing is drawn while it loads or fails (a wrong
 * zero would be worse than none); the link is there either way.
 */
import { useUnresolved } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { Link, useRoute } from '../../router/router-provider';
import { Tooltip } from '../../ui/tooltip';
import { RailItemContent, railItemClasses } from '../shell/rail-item';
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
    <Tooltip content={t('sidebar.questions')} side="right">
      <Link
        to="questions"
        params={{ slug: workspace.slug }}
        {...(current ? { 'aria-current': 'page' as const } : {})}
        className={railItemClasses(current)}
      >
        <RailItemContent
          glyph="open-question"
          label={t('sidebar.questions')}
          {...(known && loaded > 0
            ? {
                signal: {
                  kind: 'count' as const,
                  text: over ? t('sidebar.questions.many') : format.number(count),
                },
              }
            : {})}
        />
      </Link>
    </Tooltip>
  );
};
