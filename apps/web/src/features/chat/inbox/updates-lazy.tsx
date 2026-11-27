/**
 * The Updates section behind its own `import()` (D-286): the list, its reading and its rows are loaded only when a person
 * opens Updates, so the first load carries none of them.
 */
import { lazy, Suspense } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { ListSkeleton } from '../../../ui/list-column';

const Updates = lazy(async () => ({ default: (await import('./updates')).Updates }));
const ReadAll = lazy(async () => ({ default: (await import('./updates')).UpdatesReadAll }));

export const LazyUpdates = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <Suspense fallback={<ListSkeleton label={t('state.inbox.loading')} />}>
      <Updates />
    </Suspense>
  );
};

export const LazyUpdatesReadAll = (): React.JSX.Element => (
  <Suspense fallback={null}>
    <ReadAll />
  </Suspense>
);
