import { useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { EmptyState, ErrorState } from '../../ui/states';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { isSetupFailure } from '../setup/client';

export const QueryState = <T,>({
  query,
  children,
}: {
  readonly query: UseQueryResult<T>;
  readonly children: (data: T) => React.ReactNode;
}): React.JSX.Element => {
  const { t } = useI18n();
  if (query.isError && isSetupFailure(query.error) && query.error.status === 404)
    return <EmptyState title={t('app.notFound.title')} body={t('app.notFound.body')} />;
  if (query.isPending)
    return (
      <LoadingStatus label={t('common.loading')}>
        <Skeleton />
        <Skeleton />
      </LoadingStatus>
    );
  if (query.data === undefined)
    return (
      <ErrorState
        title={t('admin.loadError')}
        body={t('admin.loadError.body')}
        retryLabel={t('common.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  return (
    <>
      {query.isError && (
        <ErrorState
          title={t('admin.loadError')}
          body={t('admin.refreshError')}
          retryLabel={t('common.retry')}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}
      {children(query.data)}
    </>
  );
};

/** Each filter change remounts the list and starts a new cursor history. */
export const usePages = (): {
  after: string | undefined;
  previous: () => void;
  next: (cursor: string) => void;
  hasPrevious: boolean;
} => {
  const [cursors, setCursors] = useState<string[]>([]);
  return {
    after: cursors.at(-1),
    previous: (): void => {
      setCursors((current) => current.slice(0, -1));
    },
    next: (cursor): void => {
      setCursors((current) => [...current, cursor]);
    },
    hasPrevious: cursors.length > 0,
  };
};
export const Pagination = ({
  pages,
  nextCursor,
  busy,
}: {
  readonly pages: ReturnType<typeof usePages>;
  readonly nextCursor: string | null;
  readonly busy: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button disabled={!pages.hasPrevious || busy} onClick={pages.previous}>
        {t('admin.previous')}
      </Button>
      <Button
        disabled={nextCursor === null || busy}
        onClick={() => {
          if (nextCursor !== null) pages.next(nextCursor);
        }}
      >
        {t('admin.next')}
      </Button>
    </div>
  );
};
export const Empty = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <p role="status" className="p-6 text-body text-ink-muted">
      {t('admin.empty')}
    </p>
  );
};
export const Facts = ({
  items,
}: {
  readonly items: readonly (readonly [string, React.ReactNode])[];
}): React.JSX.Element => (
  <dl className="divide-y-hairline divide-border-subtle">
    {items.map(([label, value]) => (
      <div
        key={label}
        className="flex justify-between gap-6 px-6 py-4 max-narrow:flex-col max-narrow:gap-1 max-narrow:px-4"
      >
        <dt className="text-label text-ink-muted">{label}</dt>
        <dd className="min-w-0 text-body text-ink break-words">{value}</dd>
      </div>
    ))}
  </dl>
);
