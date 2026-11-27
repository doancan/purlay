import { useFeedPorts } from '../channel/feed-ports';
import { useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { messageId, SAVED_SEARCH_NAME_MAX, type SearchCriteria } from '@purlay/types';
import { useApi } from '../../../data/api-provider';
import { keys } from '../../../data/keys';
import { useDescribeFailure } from '../../../data/failure';
import { useI18n } from '../../../i18n/i18n-provider';
import { useRoute } from '../../../router/router-provider';
import { searchHref } from '../../../router/routes';
import { Icon } from '../../../components/icon';
import { Button } from '../../../ui/button';
import { TextField } from '../../../ui/text-field';
import { useWorkspace } from '../../shell/workspace';

export const SavedSearches = ({
  criteria,
  active,
}: {
  readonly criteria: SearchCriteria;
  readonly active: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const api = useApi();
  const ports = useFeedPorts();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Stable until a save succeeds: retrying after a lost response does not create a duplicate.
  const [id, setId] = useState(() => messageId(ports.clock.now()));
  const query = useInfiniteQuery({
    queryKey: keys.savedSearches(workspace.id),
    queryFn: ({ pageParam, signal }) => api.savedSearches(workspace.id, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: open,
  });
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      await client.invalidateQueries({ queryKey: keys.savedSearches(workspace.id) });
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-3" aria-label={t('search.saved')}>
      {/* Drawn as the disclosures in the form above are (`ui/disclosure`), from the column's edge: a button,
          not a `<details>`, because opening it is what fetches the list. */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
        className="flex w-fit items-center gap-1 rounded-sm py-1 text-label text-ink-muted transition-colors duration-hover ease-standard hover:text-ink"
      >
        <Icon name={open ? 'collapse' : 'expand'} size="sm" />
        {t('search.saved')}
      </button>
      {open && (
        <>
          {active && (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await api.saveSearch(workspace.id, id, { name: name.trim(), query: criteria });
                  setName('');
                  setId(messageId(ports.clock.now()));
                });
              }}
            >
              <div className="min-w-0 flex-1">
                <TextField
                  disabled={busy}
                  label={t('search.saveName')}
                  maxLength={SAVED_SEARCH_NAME_MAX}
                  required
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              </div>
              <Button type="submit" busy={busy}>
                {t('search.save')}
              </Button>
            </form>
          )}
          {error !== '' && (
            <p role="alert" className="text-label text-danger-text">
              {error}
            </p>
          )}
          {query.isPending && (
            <p role="status" className="text-label text-ink-muted">
              {t('common.loading')}
            </p>
          )}
          {/* What went wrong beside the way to try again: a Retry alone did not say what failed. */}
          {query.isError && (
            <div role="alert" className="flex flex-wrap items-center gap-3">
              <p className="min-w-0 flex-1 text-label text-danger-text">{describe(query.error)}</p>
              <Button
                variant="secondary"
                onClick={() => {
                  void query.refetch();
                }}
              >
                {t('common.retry')}
              </Button>
            </div>
          )}
          {query.isSuccess && query.data.pages.every((page) => page.data.length === 0) && (
            <p className="text-label text-ink-muted">{t('search.noSaved')}</p>
          )}
          <ul className="flex flex-col gap-2">
            {query.data?.pages
              .flatMap((page) => page.data)
              .map((saved) => (
                <li key={saved.id} className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 break-words text-left text-body text-accent-text hover:underline"
                    onClick={() => {
                      const { q, channelId, senderId, ...filters } = saved.query;
                      navigate(
                        searchHref(workspace.slug, q, channelId ?? null, senderId ?? null, filters),
                      );
                    }}
                  >
                    {saved.name}
                  </button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    aria-label={t('search.removeNamed', { name: saved.name })}
                    onClick={() => {
                      void run(() => api.deleteSearch(workspace.id, saved.id));
                    }}
                  >
                    {t('search.remove')}
                  </Button>
                </li>
              ))}
          </ul>
          {query.hasNextPage && (
            <Button
              variant="secondary"
              className="self-start"
              busy={query.isFetchingNextPage}
              onClick={() => {
                void query.fetchNextPage();
              }}
            >
              {t('search.more')}
            </Button>
          )}
        </>
      )}
    </section>
  );
};
