/**
 * __PASCAL__ (`docs/MODULES.md` §11): a workspace's rows, newest first, and a form that adds one. What `module:new` made is
 * the smallest screen that shows its data in all four states a person meets (loading, failed, empty, a list) and writes one
 * row; give it the module's own shape.
 *
 * - **Painted from the server's answer**, not guessed: a change asks, then reads the list again, and a refusal is a toast
 *   that says why.
 * - **This file is the module's chunk** (`manifest.ts`): nothing the shell loads first imports it, and `budget:web` looks for
 *   `__UPPER___SCREEN` in the initial chunks.
 */
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { __UPPER___TITLE_MAX } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { ListCard, ListColumn, listRowClasses } from '../../ui/list-column';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ErrorState, GlyphEmptyState } from '../../ui/states';
import { TextField } from '../../ui/text-field';
import { useToast } from '../../ui/toast';
import { NavToggle } from '../shell/nav';
import { useWorkspace } from '../shell/workspace';
import type { __PASCAL__Screens } from './manifest';

/** What `budget:web` looks for in the initial chunks: this screen's code must never be among them. */
export const __UPPER___SCREEN = 'screen-of-the-__ID__-module';

const New__PASCAL__Item = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  // Read at once, where `busy` is the render's: a second Enter in the same turn is the same row twice.
  const sending = useRef(false);
  return (
    <form
      className="flex items-end gap-3 max-narrow:flex-col max-narrow:items-stretch"
      onSubmit={(event) => {
        event.preventDefault();
        if (sending.current) return;
        sending.current = true;
        setBusy(true);
        void (async (): Promise<void> => {
          try {
            await api.create__PASCAL__Item(workspace.id, { title: title.trim() });
            setTitle('');
          } catch (failure) {
            show({ message: `${t('__ID__.new.failed')} ${describe(failure)}` });
          } finally {
            // Free before the list is read again, so a read that never ends cannot keep the form shut.
            sending.current = false;
            setBusy(false);
            void client.invalidateQueries({ queryKey: keys.__CAMEL__(workspace.id) });
          }
        })();
      }}
    >
      <div className="min-w-0 flex-1">
        <TextField
          label={t('__ID__.new.title')}
          placeholder={t('__ID__.new.placeholder')}
          value={title}
          maxLength={__UPPER___TITLE_MAX}
          autoComplete="off"
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
      </div>
      <Button type="submit" variant="primary" glyph="add" busy={busy} disabled={title.trim() === ''}>
        {t('__ID__.new.add')}
      </Button>
    </form>
  );
};

export const __PASCAL__Screen = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const api = useApi();
  const query = useQuery({
    queryKey: keys.__CAMEL__(workspace.id),
    queryFn: ({ signal }) => api.list__PASCAL__(workspace.id, signal),
  });
  const rows = query.data ?? [];

  let body: React.JSX.Element;
  if (query.isPending) {
    body = (
      <LoadingStatus label={t('__ID__.loading')} className="flex flex-col gap-4 py-2">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="w-feed" />
        ))}
      </LoadingStatus>
    );
  } else if (query.isError && query.data === undefined) {
    body = (
      <ErrorState
        title={t('__ID__.error.title')}
        body={t('__ID__.error.body')}
        retryLabel={t('common.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (rows.length === 0) {
    body = (
      <GlyphEmptyState
        glyph="bullet-list"
        tone="accent"
        title={t('__ID__.empty.title')}
        body={t('__ID__.empty.body')}
      />
    );
  } else {
    body = (
      <ListCard label={t('__ID__.title')}>
        {rows.map((row) => (
          <li
            key={row.id}
            className={cn(listRowClasses, 'px-5 py-3 text-body text-ink max-narrow:px-4')}
          >
            {row.title}
          </li>
        ))}
      </ListCard>
    );
  }

  return (
    <div data-screen={__UPPER___SCREEN} className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-header shrink-0 items-center gap-3 border-b-hairline border-border-subtle pr-4 pl-6 max-narrow:pl-4">
        <div data-header-title="" className="flex min-w-0 flex-1 items-center gap-2">
          <NavToggle />
          <span
            aria-hidden="true"
            className="inline-flex shrink-0 text-ink-subtle max-narrow:hidden"
          >
            <Icon name="bullet-list" size="lg" />
          </span>
          <h1 className="whitespace-nowrap text-heading text-ink">{t('__ID__.title')}</h1>
        </div>
      </header>
      <ListColumn>
        <New__PASCAL__Item key={workspace.id} />
        {body}
      </ListColumn>
    </div>
  );
};

/** What the manifest's `load` reads: the screen of each of the module's routes. */
export const screens: __PASCAL__Screens = { __CAMEL__: __PASCAL__Screen };
