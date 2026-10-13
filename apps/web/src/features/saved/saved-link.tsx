/**
 * "Saved" on the rail: the messages the person kept to come back to (#484, D-128).
 */
import { useI18n } from '../../i18n/i18n-provider';
import { Link, useRoute } from '../../router/router-provider';
import { Tooltip } from '../../ui/tooltip';
import { RailItemContent, railItemClasses } from '../shell/rail-item';
import { useWorkspace } from '../shell/workspace';

export const SavedLink = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { match } = useRoute();
  const current = match.name === 'saved';
  return (
    <Tooltip content={t('saved.title')} side="right">
      <Link
        to="saved"
        params={{ slug: workspace.slug }}
        {...(current ? { 'aria-current': 'page' as const } : {})}
        className={railItemClasses(current)}
      >
        <RailItemContent glyph="saved" label={t('saved.title')} />
      </Link>
    </Tooltip>
  );
};
