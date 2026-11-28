/** Paged administration shares Query ownership, revision recovery and the established settings controls. */
import {
  useMutation,
  useInfiniteQuery,
  useQueryClient,
  onlineManager,
} from '@tanstack/react-query';
import { useId, useState } from 'react';
import type {
  WorkspaceAccessListQuery,
  WorkspaceAccessSourceSummary,
  WorkspaceScopedCapability,
} from '@purlay/types/workspace-provisioning';
import { useDescribeFailure } from '../../../data/failure';
import { ApiError, isApiError } from '../../../data/errors';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { Dialog } from '../../../ui/dialog';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { TextField } from '../../../ui/text-field';
import { useSession } from '../../session/session';
import { useWorkspace } from '../../shell/workspace';
import { cardBodyClasses, cardNoteClasses } from '../page';

export const useAccessScope = (): {
  readonly workspaceId: string;
  readonly queryKey: readonly string[];
} => {
  const { workspace } = useWorkspace();
  const { user } = useSession();
  return { workspaceId: workspace.id, queryKey: ['workspace-provisioning', user.id, workspace.id] };
};

export const useAccessList = <T,>(
  part: readonly string[],
  load: (
    query: WorkspaceAccessListQuery,
    signal: AbortSignal,
  ) => Promise<{ data: T[]; nextCursor: string | null }>,
): ReturnType<
  typeof useInfiniteQuery<
    { data: T[]; nextCursor: string | null },
    Error,
    { pages: { data: T[]; nextCursor: string | null }[]; pageParams: (string | undefined)[] },
    readonly string[],
    string | undefined
  >
> => {
  const { queryKey } = useAccessScope();
  return useInfiniteQuery({
    queryKey: [...queryKey, ...part],
    queryFn: async ({ pageParam, signal }) =>
      await load({ limit: 40, ...(pageParam === undefined ? {} : { before: pageParam }) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
};

export const useAccessTask = (): {
  readonly busy: boolean;
  readonly problem: string | null;
  readonly clear: () => void;
  readonly run: (work: () => Promise<unknown>, accepted?: () => void) => void;
} => {
  const { queryKey, workspaceId } = useAccessScope();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { t } = useI18n();
  const task = useMutation({
    networkMode: 'always',
    retry: false,
    mutationFn: async (work: () => Promise<unknown>) => {
      if (!onlineManager.isOnline()) throw new ApiError(0, 'NETWORK', 'The browser is offline.');
      return await work();
    },
    onSettled: async () => {
      // Offline failures mark reads stale without waiting for paused refetches, so Cancel stays usable.
      const refetchType = onlineManager.isOnline() ? 'active' : 'none';
      await Promise.all([
        client.invalidateQueries({ queryKey, refetchType }),
        client.invalidateQueries({ queryKey: keys.members(workspaceId), refetchType }),
        client.invalidateQueries({ queryKey: keys.me, refetchType }),
      ]);
    },
  });
  return {
    busy: task.isPending,
    problem: task.isPaused
      ? t('access.offline')
      : task.error === null
        ? null
        : isApiError(task.error) &&
            ['WORKSPACE_PROVISIONING_CHANGED', 'WORKSPACE_DIRECTORY_CHANGED'].includes(
              task.error.code,
            )
          ? t('access.changed')
          : describe(task.error),
    clear: task.reset,
    run: (work, accepted): void => {
      if (task.isPending) return;
      task.mutate(work, {
        onSuccess: () => {
          accepted?.();
        },
      });
    },
  };
};

export const AccessProblem = ({
  text,
}: {
  readonly text: string | null;
}): React.JSX.Element | null =>
  text === null ? null : (
    <p role="alert" className="text-body text-danger-text">
      {text}
    </p>
  );

/**
 * The server refused because access management has not been turned on there (`WORKSPACE_PROVISIONING_READY`, D-311):
 * not a failure to read, so nothing to retry — an operator's change to the server is what moves it on.
 */
const isNotTurnedOn = (failure: Error | null): boolean =>
  isApiError(failure) && failure.code === 'WORKSPACE_PROVISIONING_NOT_READY';

const NotTurnedOn = (): React.JSX.Element => {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <div
      role="status"
      aria-labelledby={titleId}
      className="flex flex-col gap-1 px-6 py-5 max-narrow:px-4"
    >
      <p id={titleId} className="text-body font-semibold text-ink">
        {t('access.notReady.title')}
      </p>
      <p className="text-body text-ink-muted">{t('access.notReady.body')}</p>
    </div>
  );
};

export const AccessListState = ({
  pending,
  failure,
  paused = false,
  empty,
  retry,
  children,
}: {
  readonly pending: boolean;
  /** The read's failure, or null: its kind decides between Retry and a server that has the feature off. */
  readonly failure: Error | null;
  readonly paused?: boolean;
  readonly empty: boolean;
  readonly retry: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const { t } = useI18n();
  const failed = failure !== null;
  if (isNotTurnedOn(failure)) return <NotTurnedOn />;
  return (
    <>
      {(failed || paused) && (
        <div className="flex flex-wrap items-center gap-3 px-6 py-4 max-narrow:px-4">
          <p role="alert" className="min-w-0 flex-1 text-body text-danger-text">
            {t(paused ? 'access.offline' : 'access.loadFailed')}
          </p>
          <Button onClick={retry}>{t('common.retry')}</Button>
        </div>
      )}
      {pending && !failed && !paused ? (
        <LoadingStatus label={t('common.loading')} className={cardBodyClasses}>
          <Skeleton />
          <Skeleton />
        </LoadingStatus>
      ) : empty && !failed && !paused ? (
        <p role="status" className={cardNoteClasses}>
          {t('access.empty')}
        </p>
      ) : (
        children
      )}
    </>
  );
};

export const AccessSearch = ({
  value,
  change,
  label,
}: {
  readonly value: string;
  readonly change: (value: string) => void;
  readonly label?: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  return (
    <form
      className="flex min-w-0 flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        change(draft.trim());
      }}
    >
      <div className="min-w-0 flex-1">
        <TextField
          type="search"
          label={label ?? t('access.search')}
          maxLength={64}
          value={draft}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
          }}
        />
      </div>
      <Button type="submit">{t('access.find')}</Button>
    </form>
  );
};

export const More = ({
  more,
  busy,
  load,
}: {
  readonly more: boolean;
  readonly busy: boolean;
  readonly load: () => void;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  return more ? (
    <div className="px-6 py-4 max-narrow:px-4">
      <Button busy={busy} onClick={load}>
        {t('access.more')}
      </Button>
    </div>
  ) : null;
};

export const AccessConfirm = ({
  title,
  description,
  confirm,
  busy,
  problem,
  close,
  act,
  danger = true,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly confirm: string;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly close: () => void;
  readonly act: () => void;
  readonly danger?: boolean;
  readonly children?: React.ReactNode;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
      title={title}
      description={description}
      closeLabel={t('common.close')}
      focusFirst="dialog"
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={act}>
            {confirm}
          </Button>
        </>
      }
    >
      {children}
      <AccessProblem text={problem} />
    </Dialog>
  );
};

export const sourceName = (
  source: WorkspaceAccessSourceSummary,
  t: ReturnType<typeof useI18n>['t'],
): string => source.name ?? t(source.kind === 'manual' ? 'access.manual' : 'access.directory');

export const CapabilityList = ({
  capabilities,
}: {
  readonly capabilities: readonly WorkspaceScopedCapability[];
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <ul className="flex flex-col gap-1 text-body text-ink-muted">
      {capabilities.map((action) => (
        <li key={action}>{t(`access.capability.${action}`)}</li>
      ))}
    </ul>
  );
};
