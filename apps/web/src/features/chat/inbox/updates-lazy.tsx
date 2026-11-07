/**
 * The Updates section behind its own `import()` (D-286): the inbox's panel is drawn by the shell in its first frame, and the
 * list, its reading and its rows are loaded only when a person opens Updates, so the first load carries none of them.
 */
import { lazy, Suspense } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';

const Updates = lazy(async () => ({ default: (await import('./updates')).Updates }));
const ReadAll = lazy(async () => ({ default: (await import('./updates')).UpdatesReadAll }));

interface UpdatesProps {
  readonly density?: 'page' | 'panel';
  readonly limit?: number;
  readonly onDone?: () => void;
}

export const LazyUpdates = (props: UpdatesProps): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <Suspense
      fallback={
        <LoadingStatus label={t('state.inbox.loading')} className="flex flex-col gap-3 px-4 py-3">
          <Skeleton />
        </LoadingStatus>
      }
    >
      <Updates {...props} />
    </Suspense>
  );
};

export const LazyUpdatesReadAll = ({ limit }: { readonly limit?: number }): React.JSX.Element => (
  <Suspense fallback={null}>
    <ReadAll {...(limit === undefined ? {} : { limit })} />
  </Suspense>
);
