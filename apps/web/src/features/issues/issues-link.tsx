/**
 * "Issues" on the rail (D-254): the one place of the issues module the shell draws, and only where the server runs
 * it. The screen it opens is the module's own chunk (`load.tsx`).
 */
import { useI18n } from '../../i18n/i18n-provider';
import { Link, useRoute } from '../../router/router-provider';
import { Tooltip } from '../../ui/tooltip';
import { RailItemContent, railItemClasses } from '../shell/rail-item';
import { useWorkspace } from '../shell/workspace';

export const IssuesLink = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { match } = useRoute();
  const current = match.name === 'issues';
  return (
    <Tooltip content={t('issues.title')} side="right">
      <Link
        to="issues"
        params={{ slug: workspace.slug }}
        {...(current ? { 'aria-current': 'page' as const } : {})}
        className={railItemClasses(current)}
      >
        <RailItemContent glyph="issues" label={t('issues.title')} />
      </Link>
    </Tooltip>
  );
};
