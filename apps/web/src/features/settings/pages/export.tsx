/**
 * Exports asked for here, made by the server in the background, and downloaded once: an owner's export
 * of the workspace (D-140), and a person's export of their own data (D-241). One card for both — the
 * same list, the same states, the same once-only link — told apart by where it reads and asks, and by
 * the words that differ.
 *
 * An owner's export holds what the owner can see — the public channels and the private ones and direct
 * messages they are in — and nobody's address. A person's holds what they wrote and set, in every
 * workspace, and nobody else's words.
 *
 * The list is the caller's own exports, newest first, read again every few seconds while one is being
 * made. A ready one is a link that works once: following it marks it downloaded here at once, as the
 * server does, so the link is not offered twice. A failed one says why, by its code.
 */
import { PERSONAL_EXPORTS_PER_DAY, type WorkspaceExport } from '@purlay/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useState } from 'react';
import { useApi } from '../../../data/api-provider';
import { codeOf, failureKey, useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { RealtimePortsContext } from '../../../realtime/realtime-provider';
import { browserSchedule } from '../../../realtime/socket';
import { Button } from '../../../ui/button';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { useWorkspace } from '../../shell/workspace';
import { SaveOutcome, SettingsCard } from '../page';

/** How often the list is read again while an export is being made. */
const EXPORT_POLL_MS = 3_000;

/** Where a card reads and asks, and the words it says that are its own. */
interface ExportSource {
  readonly queryKey: readonly unknown[];
  readonly list: (signal: AbortSignal) => Promise<WorkspaceExport[]>;
  readonly request: () => Promise<WorkspaceExport>;
  readonly downloadUrl: (exportId: string) => string;
  readonly words: {
    readonly title: string;
    readonly description: string;
    readonly request: string;
    readonly empty: string;
    readonly inProgress: string;
    readonly requesterGone: string;
    readonly limited: string;
  };
}

const ExportsCard = ({ source }: { readonly source: ExportSource }): React.JSX.Element => {
  const { t, format } = useI18n();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const schedule = useContext(RealtimePortsContext).schedule ?? browserSchedule;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A link followed: what the server holds is read again shortly, so the list says what happened —
  // downloaded, or still ready because the request never reached it, or expired meanwhile.
  const [followed, setFollowed] = useState(false);
  const { queryKey, words } = source;

  const exports = useQuery({
    queryKey,
    queryFn: async ({ signal }) => await source.list(signal),
  });
  const list = exports.data;
  const making = list?.some((made) => made.status === 'pending') === true;
  const { refetch, dataUpdatedAt } = exports;
  // While one is being made, read again a while after each read — through the schedule the realtime
  // ports carry, so a test moves the time instead of waiting for it.
  useEffect(() => {
    if (!making) return undefined;
    return schedule(() => {
      void refetch();
    }, EXPORT_POLL_MS);
  }, [making, dataUpdatedAt, schedule, refetch]);
  useEffect(() => {
    if (!followed) return undefined;
    return schedule(() => {
      setFollowed(false);
      void refetch();
    }, EXPORT_POLL_MS);
  }, [followed, schedule, refetch]);

  const ask = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const asked = await source.request();
      client.setQueryData<WorkspaceExport[]>(queryKey, (held) => [
        asked,
        ...(held ?? []).filter((made) => made.id !== asked.id),
      ]);
    } catch (failure) {
      const code = codeOf(failure);
      setProblem(
        code === 'EXPORT_IN_PROGRESS'
          ? words.inProgress
          : code === 'RATE_LIMITED'
            ? words.limited
            : `${t('export.failed')} ${describe(failure)}`,
      );
      void exports.refetch();
    } finally {
      setBusy(false);
    }
  };

  /**
   * The link is spent the moment it is followed: shown so here at once, so it is not followed twice —
   * and then read from the server, which says whether the download reached it.
   */
  const spent = (exportId: string): void => {
    client.setQueryData<WorkspaceExport[]>(queryKey, (held) =>
      held?.map((made) =>
        made.id === exportId ? { ...made, status: 'downloaded' as const } : made,
      ),
    );
    setFollowed(true);
  };

  /** The export's own reasons in its own words; a refusal the contract names, as everywhere else. */
  const why = (failure: WorkspaceExport['failure']): string => {
    if (failure === null || failure === 'EXPORT_FAILED') return t('export.failure.failed');
    if (failure === 'EXPORT_ABANDONED') return t('export.failure.abandoned');
    if (failure === 'EXPORT_REQUESTER_GONE') return words.requesterGone;
    return t(failureKey(failure));
  };

  const stateOf = (made: WorkspaceExport): React.ReactNode => {
    switch (made.status) {
      case 'pending':
        return <span role="status">{t('export.status.pending')}</span>;
      case 'ready':
        return (
          <a
            href={source.downloadUrl(made.id)}
            download
            onClick={() => {
              spent(made.id);
            }}
            onAuxClick={() => {
              spent(made.id);
            }}
            className="text-body text-accent-text underline"
          >
            {made.sizeBytes === null || made.expiresAt === null
              ? t('export.downloadPlain')
              : t('export.download', {
                  size: format.bytes(made.sizeBytes),
                  until: format.absolute(made.expiresAt),
                })}
          </a>
        );
      case 'downloaded':
        return t('export.status.downloaded');
      case 'expired':
        return t('export.status.expired');
      case 'failed':
        return <span className="text-danger-text">{why(made.failure)}</span>;
    }
  };

  return (
    <SettingsCard
      title={words.title}
      description={words.description}
      footer={
        <>
          <SaveOutcome outcome={problem === null ? null : { ok: false, words: problem }} />
          <Button
            variant="primary"
            glyph="download"
            busy={busy}
            disabled={list === undefined || making}
            onClick={() => {
              void ask();
            }}
          >
            {words.request}
          </Button>
        </>
      }
    >
      {exports.isError ? (
        <div className="flex items-center gap-3 px-6 py-5 max-narrow:px-4">
          <p className="min-w-0 flex-1 text-body text-ink-muted">{describe(exports.error)}</p>
          <Button
            onClick={() => {
              void exports.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : list === undefined ? (
        <LoadingStatus label={t('common.loading')} className="px-6 py-5">
          <Skeleton />
        </LoadingStatus>
      ) : list.length === 0 ? (
        <p className="px-6 py-5 text-body text-ink-muted max-narrow:px-4">{words.empty}</p>
      ) : (
        <ul aria-label={t('export.list')} className="flex flex-col">
          {list.map((made) => (
            <li
              key={made.id}
              className="flex items-baseline justify-between gap-6 not-first:border-t-hairline border-border-subtle px-6 py-3 max-narrow:flex-col max-narrow:gap-1 max-narrow:px-4"
            >
              <span className="min-w-0 text-body text-ink">{stateOf(made)}</span>
              <span className="shrink-0 font-mono text-caption text-ink-muted">
                {t('export.asked', { when: format.absolute(made.createdAt) })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
};

/** An owner's export of the workspace (D-140), on Data & retention. */
export const ExportCard = (): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { workspace } = useWorkspace();
  const at = encodeURIComponent(workspace.id);
  return (
    <ExportsCard
      source={{
        queryKey: keys.exports(workspace.id),
        list: async (signal) => await api.exports(workspace.id, signal),
        request: async () => await api.requestExport(workspace.id),
        downloadUrl: (exportId) =>
          `/api/workspaces/${at}/exports/${encodeURIComponent(exportId)}/download`,
        words: {
          title: t('settings.data.export'),
          description: t('export.description'),
          request: t('export.request'),
          empty: t('export.empty'),
          inProgress: t('export.inProgress'),
          requesterGone: t('export.failure.requesterGone'),
          // Not limited by count: a refusal for load, said as any other is.
          limited: `${t('export.failed')} ${t('failure.slow')}`,
        },
      }}
    />
  );
};

/** A person's export of their own data (D-241), in Sessions & account. */
export const MyDataCard = (): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  return (
    <ExportsCard
      source={{
        queryKey: keys.myExports,
        list: async (signal) => await api.myExports(signal),
        request: async () => await api.requestMyExport(),
        downloadUrl: (exportId) => `/api/me/exports/${encodeURIComponent(exportId)}/download`,
        words: {
          title: t('myData.title'),
          description: t('myData.description'),
          request: t('myData.request'),
          empty: t('myData.empty'),
          inProgress: t('myData.inProgress'),
          requesterGone: t('myData.requesterGone'),
          limited: t('myData.limited', { count: PERSONAL_EXPORTS_PER_DAY }),
        },
      }}
    />
  );
};
