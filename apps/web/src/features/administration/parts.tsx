import { useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { GlyphEmptyState, EmptyState, ErrorState } from '../../ui/states';
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
}): React.JSX.Element | null => {
  const { t } = useI18n();
  // One page has nowhere to go: two buttons that can never be pressed are noise under a short list.
  if (!pages.hasPrevious && nextCursor === null) return null;
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
    // Announced as it appears, as the plain line was; drawn as every empty list is, inside the card it is in.
    <div role="status">
      <GlyphEmptyState
        glyph="table"
        tone="accent"
        title={t('admin.empty')}
        as="h3"
        framed={false}
      />
    </div>
  );
};
export const Facts = ({
  items,
  flush = false,
}: {
  readonly items: readonly (readonly [string, React.ReactNode])[];
  /** In a dialog, whose body already has its inset: the rows start where its heading does. */
  readonly flush?: boolean;
}): React.JSX.Element => (
  <dl className="divide-y-hairline divide-border-subtle">
    {items.map(([label, value]) => (
      <div
        key={label}
        className={cn(
          'flex items-baseline justify-between gap-6 max-narrow:flex-col max-narrow:gap-1',
          flush ? 'py-3' : 'px-6 py-4 max-narrow:px-4',
        )}
      >
        <dt className="shrink-0 text-label text-ink-muted">{label}</dt>
        {/* Counts and sizes in figures of one width, so a column of them reads down evenly. */}
        <dd className="min-w-0 text-body text-ink tabular-nums break-words narrow:text-right">
          {value}
        </dd>
      </div>
    ))}
  </dl>
);
