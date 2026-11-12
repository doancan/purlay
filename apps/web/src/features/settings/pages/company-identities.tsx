/** Explicit native identity enrollment, with observed binding IDs and a growing, paginated history. */
import { useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { MyCompanyIdentity } from '@purlay/types/workspace-identity';
import { useApi } from '../../../data/api-provider';
import { keys } from '../../../data/keys';
import { useDescribeFailure } from '../../../data/failure';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { Dialog } from '../../../ui/dialog';
import { useWorkspace } from '../../shell/workspace';
import { useSession } from '../../session/session';
import { leave } from '../../sign-in/leave';
import { SettingsCard } from '../page';
import { CompanyLoading, useCompanyAlive } from './company-parts';

export const CompanyIdentitiesCard = (): React.JSX.Element | null => {
  const { companySignInAvailable, companyWorkspaceId, user } = useSession();
  const { workspace, access } = useWorkspace();
  if ((!companySignInAvailable && companyWorkspaceId === undefined) || access.kind === 'guest')
    return null;
  return (
    <CompanyIdentities key={`${workspace.id}:${user.id}:${companyWorkspaceId ?? 'account'}`} />
  );
};

const CompanyIdentities = (): React.JSX.Element => {
  const api = useApi();
  const client = useQueryClient();
  const { t, format } = useI18n();
  const describe = useDescribeFailure();
  const { user, companyWorkspaceId } = useSession();
  const { workspace } = useWorkspace();
  const alive = useCompanyAlive();
  const pending = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<MyCompanyIdentity | null>(null);
  const queryKey = keys.myCompanyIdentities(workspace.id, user.id);
  const list = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam, signal }) =>
      await api.myCompanyIdentities(
        workspace.id,
        pageParam === undefined ? {} : { before: pageParam },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const link = async (entry: MyCompanyIdentity): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(entry.connectionId);
    setProblem(null);
    try {
      const started = await api.startCompanyIdentity({
        workspaceId: workspace.id,
        connectionId: entry.connectionId,
        revision: entry.revision,
        intent: 'link',
      });
      if (alive.current) leave.to(started.url);
    } catch (failure) {
      if (alive.current) setProblem(describe(failure));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(null);
    }
  };
  const unlink = async (): Promise<void> => {
    if (removing?.bindingId == null || pending.current) return;
    const entry = removing;
    const bindingId = removing.bindingId;
    pending.current = true;
    setBusy(entry.connectionId);
    setProblem(null);
    try {
      await api.unlinkCompanyIdentity(workspace.id, entry.connectionId, bindingId);
      if (alive.current) {
        setRemoving(null);
        await Promise.all([
          client.invalidateQueries({ queryKey }),
          client.invalidateQueries({ queryKey: keys.me }),
        ]);
      }
    } catch (failure) {
      if (alive.current) setProblem(describe(failure));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(null);
    }
  };
  const entries = list.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <SettingsCard title={t('company.links.title')} description={t('company.links.description')}>
      {problem !== null && removing === null && (
        <p role="alert" className="px-6 pt-4 text-label text-danger-text max-narrow:px-4">
          {problem}
        </p>
      )}
      {list.isError || list.data === undefined ? (
        <CompanyLoading
          failed={list.isError}
          retry={() => {
            void list.refetch();
          }}
        />
      ) : entries.length === 0 ? (
        <p className="px-6 py-5 text-body text-ink-muted max-narrow:px-4">
          {t('company.links.empty')}
        </p>
      ) : (
        <ul className="flex flex-col">
          {entries.map((entry) => (
            <li
              key={entry.connectionId}
              className="flex flex-wrap items-center justify-between gap-3 not-first:border-t-hairline border-border-subtle px-6 py-4 max-narrow:px-4"
            >
              <div className="min-w-0">
                <h3 className="text-label text-ink">{entry.name}</h3>
                <p className="text-caption text-ink-muted">
                  {entry.linkedAt !== null
                    ? t('company.links.linked', { when: format.absolute(entry.linkedAt) })
                    : t(entry.available ? 'company.links.unlinked' : 'company.links.unavailable')}
                </p>
              </div>
              {entry.bindingId === null ? (
                <Button
                  disabled={busy !== null || !entry.available || companyWorkspaceId !== undefined}
                  busy={busy === entry.connectionId}
                  onClick={() => {
                    void link(entry);
                  }}
                >
                  {t('company.links.link')}
                </Button>
              ) : (
                <Button
                  variant="dangerQuiet"
                  disabled={busy !== null}
                  onClick={() => {
                    setProblem(null);
                    setRemoving(entry);
                  }}
                >
                  {t('company.links.unlink')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <div className="px-6 py-4 max-narrow:px-4">
          <Button
            busy={list.isFetchingNextPage}
            disabled={list.isFetchingNextPage || busy !== null}
            onClick={() => {
              void list.fetchNextPage();
            }}
          >
            {t('company.links.more')}
          </Button>
        </div>
      )}
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && busy === null) setRemoving(null);
        }}
        title={t('company.links.removeTitle', { name: removing?.name ?? '' })}
        description={t('company.links.removeDescription')}
        closeLabel={t('common.cancel')}
        footer={
          <>
            <Button
              disabled={busy !== null}
              onClick={() => {
                setRemoving(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              busy={busy !== null}
              disabled={busy !== null}
              onClick={() => {
                void unlink();
              }}
            >
              {t('company.links.unlink')}
            </Button>
          </>
        }
      >
        {problem !== null && (
          <p role="alert" className="text-label text-danger-text">
            {problem}
          </p>
        )}
      </Dialog>
    </SettingsCard>
  );
};
