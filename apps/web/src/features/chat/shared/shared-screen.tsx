/** Workspace files and rendered web links, with source authorization on every page. */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SharedFilters } from '@purlay/types';
import { Icon } from '../../../components/icon';
import { useAccessRevision } from '../../../data/access-revision';
import { useDescribeFailure } from '../../../data/failure';
import { useChannels } from '../../../data/queries';
import { useI18n } from '../../../i18n/i18n-provider';
import { useRoute } from '../../../router/router-provider';
import { Button } from '../../../ui/button';
import { ListColumn, ListFilter } from '../../../ui/list-column';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { ErrorState, GlyphEmptyState } from '../../../ui/states';
import { TextField } from '../../../ui/text-field';
import { NavToggle } from '../../shell/nav';
import { useWorkspace } from '../../shell/workspace';
import { HeaderTile } from '../channel/channel-header';
import { sharedHref, sharedLocation } from './location';
import { useShared } from './query';
import { SharedControls } from './shared-filters';
import { SharedRows } from './shared-rows';

const SharedView = ({
  filters,
  invalid,
}: {
  readonly filters: SharedFilters;
  readonly invalid: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const describe = useDescribeFailure();
  const channels = useChannels(workspace.id);
  const query = useShared(workspace.id, filters, !invalid);
  const [draft, setDraft] = useState(filters.q ?? '');
  const show = (next: SharedFilters): void => {
    navigate(sharedHref(workspace.slug, next));
  };
  const change = (next: SharedFilters): void => {
    show({ ...next, q: draft.trim() });
  };
  // Refetching multiple keyset pages can overlap at a boundary after a live insert or an edit.
  const seen = new Set<string>();
  const items = (query.data?.pages.flatMap((page) => page.data) ?? []).filter((item) => {
    const key = `${item.messageId}:${item.kind === 'link' ? item.key : item.attachment.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const indexing = query.data?.pages.some((page) => page.indexing) === true;
  const narrowed = Object.keys(filters).some((key) => key !== 'view');
  let body: React.JSX.Element;
  if (invalid)
    body = (
      <ErrorState
        title={t('shared.invalid.title')}
        body={t('shared.invalid.body')}
        retryLabel={t('shared.clear')}
        onRetry={() => {
          show({ view: filters.view });
        }}
      />
    );
  else if (query.isPaused && query.data === undefined)
    body = (
      <ErrorState
        title={t('shared.offline')}
        body={t('failure.network')}
        retryLabel={t('common.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  else if (query.isPending)
    body = (
      <LoadingStatus label={t('shared.loading')} className="flex flex-col gap-4 py-2">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="w-full" />
        ))}
      </LoadingStatus>
    );
  else if (query.isError && query.data === undefined)
    body = (
      <ErrorState
        title={t('shared.error')}
        body={describe(query.error)}
        retryLabel={t('common.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  else if (items.length === 0)
    body = (
      <GlyphEmptyState
        glyph="file"
        tone="accent"
        title={t(
          narrowed
            ? 'shared.noMatch'
            : indexing
              ? 'shared.indexing.title'
              : `shared.empty.${filters.view}`,
        )}
        body={t(
          narrowed ? 'shared.noMatch.body' : indexing ? 'shared.indexing' : 'shared.empty.body',
        )}
      />
    );
  else
    body = (
      <SharedRows
        // Media viewers and inline previews hold a snapshot. A source inventory change retires it.
        key={items
          .map(
            (item) => `${item.messageId}:${item.kind === 'file' ? item.attachment.id : item.key}`,
          )
          .join(',')}
        items={items}
        channels={channels.data ?? []}
      />
    );
  return (
    <>
      <header className="flex h-header shrink-0 items-center gap-2 border-b-hairline border-border-subtle pr-4 pl-6 max-narrow:pl-4">
        <NavToggle />
        <HeaderTile>
          <Icon name="file" size="lg" />
        </HeaderTile>
        <h1 className="text-heading text-ink">{t('shared.title')}</h1>
      </header>
      <ListColumn>
        <ListFilter
          label={t('shared.show')}
          value={filters.view}
          choices={[
            { value: 'files', label: t('shared.files') },
            { value: 'links', label: t('shared.links') },
          ]}
          onChange={(view) => {
            const { type, ...rest } = filters;
            change({ ...rest, view, ...(view === 'files' && type !== undefined ? { type } : {}) });
          }}
        />
        <form
          role="search"
          className="flex flex-col gap-3 rounded-xl border-hairline border-border-subtle bg-surface-100 px-5 py-4 shadow-card max-narrow:px-4"
          onSubmit={(event) => {
            event.preventDefault();
            change(filters);
          }}
        >
          <TextField
            label={t('shared.search')}
            type="search"
            maxLength={256}
            autoComplete="off"
            value={draft}
            hint={t(filters.view === 'files' ? 'shared.search.files' : 'shared.search.links')}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
          <SharedControls value={filters} onChange={change} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="secondary">
              {t('shared.apply')}
            </Button>
            {narrowed && (
              <Button
                variant="ghost"
                onClick={() => {
                  show({ view: filters.view });
                }}
              >
                {t('shared.clear')}
              </Button>
            )}
          </div>
        </form>
        {indexing && (
          <p role="status" className="text-label text-ink-muted">
            {t('shared.indexing')}
          </p>
        )}
        {query.data !== undefined && (query.isError || query.isPaused) && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 text-label text-ink-muted"
          >
            <p>{t(query.isPaused ? 'shared.offline' : 'shared.stale')}</p>
            <Button
              variant="ghost"
              onClick={() => {
                void query.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        )}
        {body}
        {query.hasNextPage && (
          <div className="flex justify-center">
            <Button
              variant="secondary"
              busy={query.isFetchingNextPage}
              onClick={() => {
                void query.fetchNextPage();
              }}
            >
              {t('shared.more')}
            </Button>
          </div>
        )}
      </ListColumn>
    </>
  );
};

export const SharedScreen = (): React.JSX.Element => {
  const { search } = useRoute();
  const { workspace } = useWorkspace();
  const revision = useAccessRevision(useQueryClient());
  return (
    <SharedView key={`${workspace.id}:${search}:${String(revision)}`} {...sharedLocation(search)} />
  );
};
