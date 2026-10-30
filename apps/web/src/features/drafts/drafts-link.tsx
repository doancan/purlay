/** "Drafts and sent" on the rail (D-215): a place, as Saved is, with no count of its own (D-110). */
import { useI18n } from '../../i18n/i18n-provider';
import { Link, useRoute } from '../../router/router-provider';
import { Tooltip } from '../../ui/tooltip';
import { RailItemContent, railItemClasses } from '../shell/rail-item';
import { useWorkspace } from '../shell/workspace';

export const DraftsLink = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { match } = useRoute();
  const current = match.name === 'drafts';
  return (
    <Tooltip content={t('drafts.title')} side="right">
      <Link
        to="drafts"
        params={{ slug: workspace.slug }}
        {...(current ? { 'aria-current': 'page' as const } : {})}
        className={railItemClasses(current)}
      >
        <RailItemContent glyph="edit" label={t('drafts.title')} />
      </Link>
    </Tooltip>
  );
};
