/**
 * "Search" on the rail: the words of every channel the person can see (D-105).
 */
import { useI18n } from '../../i18n/i18n-provider';
import { Link, useRoute } from '../../router/router-provider';
import { Tooltip } from '../../ui/tooltip';
import { RailItemContent, railItemClasses } from '../shell/rail-item';
import { useWorkspace } from '../shell/workspace';

export const SearchLink = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { match } = useRoute();
  const current = match.name === 'search';
  return (
    <Tooltip content={t('search.title')} side="right">
      <Link
        to="search"
        params={{ slug: workspace.slug }}
        {...(current ? { 'aria-current': 'page' as const } : {})}
        className={railItemClasses(current)}
      >
        <RailItemContent glyph="search" label={t('search.title')} />
      </Link>
    </Tooltip>
  );
};
