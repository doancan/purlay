/**
 * Accounts (D-233), on Administration → Server: the administrator finds an account by name, username or
 * address and suspends it, or lifts a suspension.
 *
 * Suspending signs the person out everywhere and keeps them out, so it asks once more on the row, in
 * words that say so; lifting asks nothing — it only lets somebody back in. An administrator's row,
 * the caller's own among them, has no button: the server refuses it, and the page does not offer it.
 * The list is read again after each change, so what is shown is what the server kept.
 */
import type { ServerAccount } from '@purlay/types';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { TextField } from '../../../ui/text-field';
import { SettingsCard } from '../page';
import { useServerClient } from '../server-context';
import { ChangeFailure, Inset } from '../server-parts';

/** The card's queries, by what was typed: read again after a change. */
const ACCOUNTS_KEY = ['server', 'accounts'] as const;

export const AccountsCard = (): React.JSX.Element => {
  const { t, format } = useI18n();
  const client = useServerClient();
  const queries = useQueryClient();
  const [typed, setTyped] = useState('');
  const words = useDeferredValue(typed.trim());
  const [asking, setAsking] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  const accounts = useQuery({
    queryKey: [...ACCOUNTS_KEY, words],
    queryFn: async ({ signal }) => await client.accounts(words, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const change = async (account: ServerAccount, suspend: boolean): Promise<void> => {
    setWorking(account.id);
    setFailure(null);
    try {
      await (suspend ? client.suspend(account.id) : client.lift(account.id));
      setAsking(null);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setWorking(null);
      await queries.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    }
  };

  const row = (account: ServerAccount): React.JSX.Element => {
    const described = `account-${account.id}`;
    const suspended = account.suspendedAt !== null;
    return (
      <li
        key={account.id}
        className="flex flex-wrap items-center gap-x-4 gap-y-2 not-first:border-t-hairline border-border-subtle px-6 py-3 max-narrow:px-4"
      >
        <span id={described} className="flex min-w-0 flex-1 flex-col">
          <span className="text-label text-ink break-words">{account.displayName}</span>
          <span className="text-caption text-ink-muted break-all">
            {account.email === null
              ? `@${account.username}`
              : `@${account.username} · ${account.email}`}
          </span>
          {account.isServerAdmin && (
            <span className="text-caption text-ink-muted">
              {t('settings.server.accounts.admin')}
            </span>
          )}
          {account.suspendedAt !== null && (
            <span className="text-caption text-danger-text">
              {t('settings.server.accounts.suspendedOn', {
                when: format.absolute(account.suspendedAt),
              })}
            </span>
          )}
        </span>
        {account.isServerAdmin ? null : suspended ? (
          <Button
            aria-describedby={described}
            busy={working === account.id}
            onClick={() => {
              void change(account, false);
            }}
          >
            {t('settings.server.accounts.lift')}
          </Button>
        ) : asking === account.id ? (
          <span className="flex w-full flex-wrap items-center justify-end gap-2">
            <span className="min-w-0 flex-1 text-caption text-ink">
              {t('settings.server.accounts.ask', { name: account.displayName })}
            </span>
            <Button
              onClick={() => {
                setAsking(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              aria-describedby={described}
              busy={working === account.id}
              onClick={() => {
                void change(account, true);
              }}
            >
              {t('settings.server.accounts.suspend')}
            </Button>
          </span>
        ) : (
          <Button
            variant="dangerQuiet"
            aria-describedby={described}
            onClick={() => {
              setFailure(null);
              setAsking(account.id);
            }}
          >
            {t('settings.server.accounts.suspend')}
          </Button>
        )}
      </li>
    );
  };

  return (
    <SettingsCard
      title={t('settings.server.accounts.title')}
      description={t('settings.server.accounts.description')}
    >
      <Inset>
        <TextField
          label={t('settings.server.accounts.find')}
          type="search"
          value={typed}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
        />
        {failure !== null && <ChangeFailure failure={failure} />}
      </Inset>
      {accounts.isError ? (
        <Inset>
          <ChangeFailure failure={accounts.error} />
          <span>
            <Button
              onClick={() => {
                void accounts.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </span>
        </Inset>
      ) : accounts.data === undefined ? (
        <LoadingStatus label={t('common.loading')} className="flex flex-col gap-3 px-6 py-5">
          <Skeleton />
          <Skeleton />
        </LoadingStatus>
      ) : accounts.data.length === 0 ? (
        <p className="border-t-hairline border-border-subtle px-6 py-5 text-body text-ink-muted max-narrow:px-4">
          {t('settings.server.accounts.none')}
        </p>
      ) : (
        <ul
          aria-label={t('settings.server.accounts.title')}
          className="flex flex-col border-t-hairline border-border-subtle"
        >
          {accounts.data.map(row)}
        </ul>
      )}
    </SettingsCard>
  );
};
