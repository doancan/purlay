/** Source-aware lifecycle management keeps local offboarding blocks visible across directory replays. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UserRole } from '@purlay/types';
import type {
  WorkspaceAccessPeopleQuery,
  WorkspaceAccessPerson,
  WorkspaceAccessSourceSummary,
  WorkspaceMemberAccess,
  WorkspaceOffboardingPreview,
} from '@purlay/types/workspace-provisioning';
import { useApi } from '../../../data/api-provider';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { Avatar } from '../../../ui/avatar';
import { Select } from '../../../ui/select';
import { Dialog } from '../../../ui/dialog';
import { SettingsCard, SettingsPage } from '../page';
import { useWorkspaceRole } from '../role';
import { useSession } from '../../session/session';
import {
  AccessConfirm,
  AccessListState,
  AccessProblem,
  AccessSearch,
  CapabilityList,
  More,
  sourceName,
  useAccessList,
  useAccessScope,
  useAccessTask,
} from './shared';
import { AccessGrants } from './grants';

export const AccessPeoplePage = (): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { workspaceId } = useAccessScope();
  const [search, setSearch] = useState('');
  const [state, setState] = useState<WorkspaceAccessPeopleQuery['state']>();
  const [selected, setSelected] = useState<WorkspaceAccessPerson | null>(null);
  const people = useAccessList(['people', search, state ?? 'all'], (query, signal) =>
    api.workspaceAccessPeople(
      workspaceId,
      { ...query, q: search, ...(state === undefined ? {} : { state }) },
      signal,
    ),
  );
  const items = people.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <SettingsPage title={t('access.people.title')} description={t('access.people.description')}>
      <SettingsCard title={t('access.people.title')}>
        <div className="flex items-end gap-3 p-4 max-narrow:flex-col max-narrow:items-stretch">
          <div className="min-w-0 flex-1">
            <AccessSearch
              value={search}
              change={(value) => {
                setSearch(value);
                setSelected(null);
              }}
              label={t('access.people.search')}
            />
          </div>
          <label className="flex flex-col gap-1 text-label text-ink">
            {t('access.people.state')}
            <Select
              value={state ?? 'all'}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setState(
                  value === 'active' || value === 'inactive' || value === 'offboarded'
                    ? value
                    : undefined,
                );
                setSelected(null);
              }}
            >
              <option value="all">{t('access.people.all')}</option>
              {(['active', 'inactive', 'offboarded'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`access.person.${value}`)}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <AccessListState
          pending={people.isPending}
          failed={people.isError}
          paused={people.isPaused}
          empty={items.length === 0}
          retry={() => {
            void people.refetch();
          }}
        >
          <ul>
            {items.map((person) => (
              <li
                key={person.id}
                className="flex items-start gap-3 border-t-hairline border-border-subtle px-6 py-4 max-narrow:flex-wrap max-narrow:px-4"
              >
                <Avatar name={person.user.displayName} username={person.user.username} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-label text-ink">{person.user.displayName}</p>
                  <p className="break-words text-body text-ink-muted">
                    @{person.user.username} · {t(`access.person.${person.access.state}`)}
                  </p>
                </div>
                <Button
                  aria-expanded={selected?.id === person.id}
                  onClick={() => {
                    setSelected(selected?.id === person.id ? null : person);
                  }}
                >
                  {t('access.people.open')}
                </Button>
              </li>
            ))}
          </ul>
          <More
            more={people.hasNextPage}
            busy={people.isFetchingNextPage}
            load={() => {
              void people.fetchNextPage();
            }}
          />
        </AccessListState>
      </SettingsCard>
      {selected !== null && (
        <PersonAccess
          key={selected.id}
          person={selected}
          stale={people.isError || people.isPaused}
        />
      )}
    </SettingsPage>
  );
};

const PersonAccess = ({
  person,
  stale,
}: {
  readonly person: WorkspaceAccessPerson;
  readonly stale: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { workspaceId, queryKey } = useAccessScope();
  const actor = useWorkspaceRole();
  const { user } = useSession();
  const [manual, setManual] = useState(false);
  const [revoking, setRevoking] = useState<WorkspaceAccessSourceSummary | null>(null);
  const [grantSource, setGrantSource] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorkspaceOffboardingPreview | null>(null);
  const [readmitting, setReadmitting] = useState(false);
  const task = useAccessTask();
  const query = useQuery({
    queryKey: [...queryKey, 'person', person.id],
    queryFn: async ({ signal }) => await api.workspaceMemberAccess(workspaceId, person.id, signal),
  });
  const access = query.data;
  const blocked = stale || query.isError || query.isPaused || access === undefined;
  const mayManage = actor === 'owner' || (actor === 'admin' && access?.role !== 'owner');
  const mayOffboard = mayManage && user.id !== person.id && access?.state !== 'offboarded';
  const source = access?.sources.find((item) => item.id === grantSource);
  return (
    <>
      <SettingsCard title={person.user.displayName} description={`@${person.user.username}`}>
        <AccessListState
          pending={query.isPending}
          failed={query.isError}
          paused={query.isPaused}
          empty={false}
          retry={() => {
            void query.refetch();
          }}
        >
          {access !== undefined && (
            <div className="flex min-w-0 flex-col gap-5 px-6 py-5 max-narrow:px-4">
              <p className="text-label text-ink">
                {t(`access.person.${access.state}`)}
                {access.role === null ? '' : ` · ${t(`members.role.${access.role}`)}`}
              </p>
              {access.state === 'offboarded' && (
                <p className="text-body text-ink-muted">{t('access.people.blockedHint')}</p>
              )}
              <CapabilityList capabilities={access.workspaceCapabilities} />
              <div className="flex flex-wrap gap-2">
                {mayManage && access.state !== 'offboarded' && (
                  <Button
                    disabled={blocked}
                    onClick={() => {
                      setManual(true);
                    }}
                  >
                    {t('access.people.manual')}
                  </Button>
                )}
                {mayOffboard && (
                  <Button
                    variant="dangerQuiet"
                    disabled={blocked || task.busy}
                    busy={task.busy}
                    onClick={() => {
                      task.clear();
                      task.run(async () => {
                        const result = await api.previewWorkspaceOffboarding(
                          workspaceId,
                          person.id,
                          { revision: access.revision },
                        );
                        setPreview(result);
                      });
                    }}
                  >
                    {t('access.people.previewOffboard')}
                  </Button>
                )}
                {mayManage && access.state === 'offboarded' && (
                  <Button
                    disabled={blocked}
                    onClick={() => {
                      task.clear();
                      setReadmitting(true);
                    }}
                  >
                    {t('access.people.readmit')}
                  </Button>
                )}
              </div>
              <AccessProblem
                text={preview === null && !readmitting && revoking === null ? task.problem : null}
              />
              <h3 className="text-heading text-ink">{t('access.people.sources')}</h3>
              <p className="text-body text-ink-muted">{t('access.people.sourceHint')}</p>
              {access.sources.length === 0 ? (
                <p className="text-body text-ink-muted">{t('access.people.noSources')}</p>
              ) : (
                <ul className="flex flex-col gap-4">
                  {access.sources.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-start justify-between gap-3 max-narrow:flex-col"
                    >
                      <div className="min-w-0">
                        <p className="break-words text-label text-ink">{sourceName(item, t)}</p>
                        <p className="text-body text-ink-muted">
                          {t(item.kind === 'manual' ? 'access.manual' : 'access.directory')} ·{' '}
                          {t(`access.source.${item.state}`)} ·{' '}
                          {t(`members.role.${item.builtinRole}`)}
                        </p>
                        <p className="text-body text-ink-muted">
                          {t(
                            item.effective
                              ? 'access.people.effective'
                              : 'access.people.ineffective',
                          )}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          aria-expanded={grantSource === item.id}
                          onClick={() => {
                            setGrantSource(grantSource === item.id ? null : item.id);
                          }}
                        >
                          {t('access.grants.title')}
                        </Button>
                        {mayManage &&
                          access.state !== 'offboarded' &&
                          item.state === 'active' &&
                          user.id !== person.id && (
                            <Button
                              variant="dangerQuiet"
                              disabled={blocked}
                              onClick={() => {
                                task.clear();
                                setRevoking(item);
                              }}
                            >
                              {t('access.people.revoke')}
                            </Button>
                          )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </AccessListState>
      </SettingsCard>
      {source !== undefined && (
        <SettingsCard title={sourceName(source, t)}>
          <div className="px-6 py-5 max-narrow:px-4">
            <AccessGrants
              subject={{ kind: 'source', sourceId: source.id }}
              revision={source.revision}
              disabled={
                blocked || !mayManage || source.state !== 'active' || access.state !== 'active'
              }
            />
          </div>
        </SettingsCard>
      )}
      {manual && access !== undefined && (
        <ManualAccess
          access={access}
          userId={person.id}
          owner={actor === 'owner'}
          close={() => {
            setManual(false);
          }}
        />
      )}
      {revoking !== null && (
        <AccessConfirm
          title={t('access.people.revokeTitle', { name: sourceName(revoking, t) })}
          description={t('access.people.revokeHint')}
          confirm={t('access.people.revoke')}
          busy={task.busy}
          problem={task.problem}
          close={() => {
            setRevoking(null);
          }}
          act={() => {
            task.run(
              () =>
                api.revokeWorkspaceAccessSource(workspaceId, person.id, revoking.id, {
                  revision: revoking.revision,
                }),
              () => {
                setRevoking(null);
              },
            );
          }}
        />
      )}
      {preview !== null && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !task.busy) setPreview(null);
          }}
          title={t('access.people.offboardTitle', { name: person.user.displayName })}
          description={t('access.people.offboardHint')}
          closeLabel={t('common.close')}
          focusFirst="dialog"
          footer={
            <>
              <Button
                disabled={task.busy}
                onClick={() => {
                  setPreview(null);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                busy={task.busy}
                disabled={
                  blocked ||
                  !preview.canOffboard ||
                  preview.access.revision !== access.revision ||
                  task.problem !== null
                }
                onClick={() => {
                  task.run(
                    () =>
                      api.confirmWorkspaceOffboarding(workspaceId, person.id, {
                        revision: preview.access.revision,
                        confirm: true,
                      }),
                    () => {
                      setPreview(null);
                    },
                  );
                }}
              >
                {t('access.people.offboard')}
              </Button>
            </>
          }
        >
          <p className="text-body text-ink">
            {t('access.people.impact', {
              channels: preview.affectedChannelCount,
              sessions: preview.sourceSessionCount,
            })}
          </p>
          {!preview.canOffboard && (
            <AccessProblem
              text={t(
                preview.reason === 'last_owner'
                  ? 'access.people.lastOwner'
                  : 'access.people.protected',
              )}
            />
          )}
          {preview.access.revision !== access?.revision && (
            <AccessProblem text={t('access.changed')} />
          )}
          <AccessProblem text={task.problem} />
        </Dialog>
      )}
      {readmitting && access !== undefined && (
        <AccessConfirm
          title={t('access.people.readmitTitle', { name: person.user.displayName })}
          description={t('access.people.readmitHint')}
          confirm={t('access.people.readmit')}
          danger={false}
          busy={task.busy}
          problem={task.problem}
          close={() => {
            setReadmitting(false);
          }}
          act={() => {
            task.run(
              () =>
                api.readmitWorkspaceMember(workspaceId, person.id, {
                  revision: access.revision,
                  confirm: true,
                }),
              () => {
                setReadmitting(false);
              },
            );
          }}
        />
      )}
    </>
  );
};

const ManualAccess = ({
  access,
  userId,
  owner,
  close,
}: {
  readonly access: WorkspaceMemberAccess;
  readonly userId: string;
  readonly owner: boolean;
  readonly close: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { workspaceId } = useAccessScope();
  const [role, setRole] = useState<UserRole>(
    access.sources.find((source) => source.kind === 'manual' && source.state === 'active')
      ?.builtinRole ?? 'member',
  );
  const task = useAccessTask();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !task.busy) close();
      }}
      title={t('access.people.manual')}
      description={t('access.people.manualHint')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button disabled={task.busy} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={task.busy}
            onClick={() => {
              task.run(
                () =>
                  api.addManualWorkspaceAccess(workspaceId, userId, {
                    revision: access.revision,
                    role,
                  }),
                close,
              );
            }}
          >
            {t('access.people.addManual')}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-2 text-label text-ink">
        {t('access.people.nativeRole')}
        <Select
          disabled={task.busy}
          value={role}
          onChange={(event) => {
            const next = event.currentTarget.value;
            if (next === 'member' || next === 'admin' || (next === 'owner' && owner)) setRole(next);
          }}
        >
          {(owner ? (['member', 'admin', 'owner'] as const) : (['member', 'admin'] as const)).map(
            (value) => (
              <option key={value} value={value}>
                {t(`members.role.${value}`)}
              </option>
            ),
          )}
        </Select>
      </label>
      <AccessProblem text={task.problem} />
    </Dialog>
  );
};
