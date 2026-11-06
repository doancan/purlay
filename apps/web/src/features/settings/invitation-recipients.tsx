import { systemClock } from '../../system-clock';
import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { InvitationDelivery, InvitationRecipient } from '@purlay/types';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { useWorkspace } from '../shell/workspace';
import { SettingsCard } from './page';

const Delivery = ({ value }: { readonly value: InvitationDelivery }): React.JSX.Element => {
  const { t, format } = useI18n();
  return (
    <div className="flex flex-col gap-1 text-caption text-ink-muted">
      <span>
        {t(`invite.delivery.${value.result}`)} ·{' '}
        {format.absolute(value.finishedAt ?? value.createdAt)}
      </span>
      {value.failure !== null && <span>{t(`invite.delivery.failure.${value.failure}`)}</span>}
      <span>
        {value.revokedAt !== null
          ? t('invite.delivery.revoked')
          : t('invite.delivery.expires', { until: format.absolute(value.expiresAt) })}
      </span>
    </div>
  );
};

const History = ({ recipientId }: { readonly recipientId: string }): React.JSX.Element => {
  const api = useApi();
  const { workspace } = useWorkspace();
  const { t } = useI18n();
  const list = useInfiniteQuery({
    queryKey: keys.invitationDeliveries(workspace.id, recipientId),
    queryFn: async ({ pageParam, signal }) =>
      await api.invitationDeliveries(workspace.id, recipientId, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return (
    <div className="flex flex-col gap-3">
      {list.isPending && (
        <LoadingStatus label={t('common.loading')}>
          <Skeleton />
        </LoadingStatus>
      )}
      {list.isError && (
        <div role="alert">
          <p>{t('invite.delivery.failedRead')}</p>
          <Button
            onClick={() => {
              void list.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}
      {list.data?.pages
        .flatMap((page) => page.data)
        .map((attempt) => (
          <Delivery key={attempt.id} value={attempt} />
        ))}
      {list.hasNextPage && (
        <Button
          busy={list.isFetchingNextPage}
          onClick={() => {
            void list.fetchNextPage();
          }}
        >
          {t('settings.invitations.older')}
        </Button>
      )}
    </div>
  );
};

const Recipient = ({ value }: { readonly value: InvitationRecipient }): React.JSX.Element => {
  const api = useApi();
  const client = useQueryClient();
  const { workspace } = useWorkspace();
  const { t, format } = useI18n();
  const describe = useDescribeFailure();
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState<'resend' | 'revoke' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The recipient poll sees asynchronous receipts and revocations. Refresh an open history
  // when that evidence changes; a closed history is only marked stale until it is opened.
  // Cancel an older read first, including a first page that has not answered yet.
  useEffect(() => {
    const queryKey = keys.invitationDeliveries(workspace.id, value.id);
    void client.cancelQueries({ queryKey }).then(async () => {
      await client.invalidateQueries({ queryKey });
    });
  }, [client, workspace.id, value.id, value.latest]);
  const act = async (action: 'resend' | 'revoke'): Promise<void> => {
    if (busy !== null) return;
    setBusy(action);
    setProblem(null);
    try {
      if (action === 'resend') await api.resendInvitationRecipient(workspace.id, value.id);
      else await api.revokeInvitationRecipient(workspace.id, value.id);
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.invitationRecipients(workspace.id) }),
        client.invalidateQueries({ queryKey: keys.invitationDeliveries(workspace.id, value.id) }),
      ]);
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(null);
    }
  };
  const status =
    value.joinedAt !== null
      ? 'joined'
      : (value.admission ??
        (value.latest.revokedAt !== null
          ? 'revoked'
          : Date.parse(value.latest.expiresAt) <= systemClock.now().getTime()
            ? 'expired'
            : value.latest.result));
  return (
    <li className="flex flex-col gap-3 not-first:border-t-hairline border-border-subtle px-6 py-4 max-narrow:px-4">
      <div className="flex flex-wrap items-start justify-between gap-3 max-narrow:flex-col">
        <div className="min-w-0 flex-1">
          <p id={`recipient-${value.id}`} className="text-body text-ink break-words">
            {value.address}
          </p>
          <p className="text-label text-ink-muted" role="status">
            {t(`invite.delivery.${status}`)}
          </p>
          {value.joinedAt !== null && (
            <p className="text-caption text-ink-muted">{format.absolute(value.joinedAt)}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            aria-describedby={`recipient-${value.id}`}
            busy={busy === 'resend'}
            disabled={busy !== null || value.joinedAt !== null || value.latest.result === 'queued'}
            onClick={() => {
              void act('resend');
            }}
          >
            {t('invite.delivery.resend')}
          </Button>
          <Button
            variant="dangerQuiet"
            aria-describedby={`recipient-${value.id}`}
            busy={busy === 'revoke'}
            disabled={busy !== null || value.latest.revokedAt !== null}
            onClick={() => {
              void act('revoke');
            }}
          >
            {t('invite.admin.revoke')}
          </Button>
        </div>
      </div>
      <Delivery value={value.latest} />
      {problem !== null && (
        <p role="alert" className="text-label text-danger-text">
          {problem}
        </p>
      )}
      <Button
        variant="ghost"
        aria-describedby={`recipient-${value.id}`}
        aria-expanded={history}
        onClick={() => {
          setHistory(!history);
        }}
      >
        {t('invite.delivery.history')}
      </Button>
      {history && <History recipientId={value.id} />}
    </li>
  );
};

export const InvitationRecipients = (): React.JSX.Element => {
  const api = useApi();
  const { workspace } = useWorkspace();
  const { t } = useI18n();
  const list = useInfiniteQuery({
    queryKey: keys.invitationRecipients(workspace.id),
    queryFn: async ({ pageParam, signal }) =>
      await api.invitationRecipients(workspace.id, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Mail receipts and approval happen after the request; only a visible page keeps polling.
    refetchInterval: 5_000,
  });
  const rows = list.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <SettingsCard title={t('invite.delivery.title')}>
      <p className="px-6 py-4 text-body text-ink-muted max-narrow:px-4">
        {t('invite.delivery.note')}
      </p>
      {list.isPending ? (
        <LoadingStatus label={t('common.loading')}>
          <Skeleton />
        </LoadingStatus>
      ) : list.data !== undefined && rows.length === 0 ? (
        <p className="px-6 py-4 text-body text-ink-muted max-narrow:px-4">
          {t('invite.delivery.empty')}
        </p>
      ) : null}
      {list.isError && (
        <div role="alert" className="flex flex-wrap items-center gap-3 px-6 py-4 max-narrow:px-4">
          <p>{t('invite.delivery.failedRead')}</p>
          <Button
            busy={list.isFetching}
            onClick={() => {
              void list.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}
      <ul aria-label={t('invite.delivery.title')}>
        {rows.map((row) => (
          <Recipient key={row.id} value={row} />
        ))}
      </ul>
      {list.hasNextPage && (
        <div className="px-6 py-4">
          <Button
            busy={list.isFetchingNextPage}
            onClick={() => {
              void list.fetchNextPage();
            }}
          >
            {t('settings.invitations.older')}
          </Button>
        </div>
      )}
    </SettingsCard>
  );
};
