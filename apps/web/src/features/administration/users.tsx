import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ServerUser, ServerUsersQuery } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { TextField } from '../../ui/text-field';
import { Select } from '../../ui/select';
import { Dialog } from '../../ui/dialog';
import { SettingsCard } from '../settings/page';
import { ChangeFailure } from '../settings/server-parts';
import { useServerClient } from '../settings/server-context';
import { useSession } from '../session/session';
import { keys } from '../../data/keys';
import { useAdministrationClient } from './context';
import { Empty, Facts, Pagination, QueryState, usePages } from './parts';

type AccountAction = 'grant' | 'revoke' | 'endSessions' | 'suspend' | 'approve' | 'deny';
export const Users = (): React.JSX.Element => {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<ServerUsersQuery['status']>();
  const [filter, setFilter] = useState<ServerUsersQuery>({});
  return (
    <>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter({ q: q.trim(), ...(status === undefined ? {} : { status }) });
        }}
      >
        <div className="min-w-0 flex-1">
          <TextField
            label={t('admin.search')}
            value={q}
            maxLength={100}
            onChange={(event) => {
              setQ(event.target.value);
            }}
          />
        </div>
        <label className="flex flex-col gap-1 text-label text-ink">
          {t('admin.status')}
          <Select
            value={status ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              if (
                value === '' ||
                value === 'active' ||
                value === 'suspended' ||
                value === 'admins' ||
                value === 'pending' ||
                value === 'denied'
              )
                setStatus(value || undefined);
            }}
          >
            <option value="">{t('admin.all')}</option>
            <option value="active">{t('admin.active')}</option>
            <option value="suspended">{t('admin.suspended')}</option>
            <option value="admins">{t('admin.admins')}</option>
            <option value="pending">{t('admin.pending')}</option>
            <option value="denied">{t('admin.denied')}</option>
          </Select>
        </label>
        <Button type="submit">{t('admin.find')}</Button>
      </form>
      <UserList key={JSON.stringify(filter)} filter={filter} />
    </>
  );
};

const UserList = ({ filter }: { readonly filter: ServerUsersQuery }): React.JSX.Element => {
  const client = useAdministrationClient();
  const { t } = useI18n();
  const pages = usePages();
  const session = useSession();
  const queries = useQueryClient();
  const providers = useServerClient();
  const query = useQuery({
    queryKey: ['server', 'users', filter, pages.after],
    queryFn: async ({ signal }) =>
      await client.users(
        { ...filter, ...(pages.after === undefined ? {} : { after: pages.after }) },
        signal,
      ),
    retry: false,
  });
  const [selected, setSelected] = useState<ServerUser | null>(null);
  const [asking, setAsking] = useState<{ user: ServerUser; action: AccountAction } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [outcome, setOutcome] = useState(false);
  const refresh = async (): Promise<void> => {
    await queries.invalidateQueries({ queryKey: ['server'] });
    await queries.invalidateQueries({ queryKey: keys.me });
  };
  const change = async (user: ServerUser, action: AccountAction | 'restore'): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setOutcome(false);
    try {
      if (action === 'approve' || action === 'deny')
        await client.admission(user.id, action === 'approve' ? 'approved' : 'denied');
      else if (action === 'grant' || action === 'revoke')
        await client.role(user.id, action === 'grant');
      else if (action === 'endSessions') await client.revokeSessions(user.id);
      else if (action === 'restore') await providers.lift(user.id);
      else await providers.suspend(user.id);
      setAsking(null);
      setOutcome(true);
    } catch (error) {
      setFailure(error);
    } finally {
      await refresh();
      setBusy(false);
    }
  };
  return (
    <>
      {failure !== null && asking === null && <ChangeFailure failure={failure} />}
      {outcome && (
        <p role="status" className="text-body text-ink-muted">
          {t('admin.saved')}
        </p>
      )}
      <QueryState query={query}>
        {(data) => (
          <>
            <SettingsCard title={t('admin.users')}>
              {data.data.length === 0 ? (
                <Empty />
              ) : (
                <ul>
                  {data.data.map((user) => (
                    <li
                      key={user.id}
                      className="flex flex-wrap items-start gap-4 not-last:border-b-hairline border-border-subtle px-6 py-4 max-narrow:px-4"
                    >
                      <div className="min-w-0 flex-1">
                        <h2 className="text-label text-ink break-words">{user.displayName}</h2>
                        <p className="text-caption text-ink-muted break-all">
                          @{user.username} · {user.email}
                        </p>
                        <p className="text-caption text-ink-muted">
                          {user.admissionState !== 'approved'
                            ? t(`admin.${user.admissionState}`)
                            : user.isServerAdmin
                              ? t('settings.server.accounts.admin')
                              : user.suspendedAt === null
                                ? t('admin.active')
                                : t('admin.suspended')}{' '}
                          · {t(user.emailVerified ? 'admin.verified' : 'admin.unverified')}
                        </p>
                      </div>
                      <div className="flex w-full flex-wrap gap-2">
                        <Button
                          disabled={busy}
                          onClick={() => {
                            setSelected(user);
                          }}
                        >
                          {t('admin.details')}
                        </Button>
                        {user.isServerAdmin ? (
                          <Button
                            disabled={busy}
                            onClick={() => {
                              setAsking({ user, action: 'revoke' });
                            }}
                          >
                            {t('admin.revoke')}
                          </Button>
                        ) : (
                          <Button
                            disabled={
                              busy ||
                              user.suspendedAt !== null ||
                              !user.emailVerified ||
                              user.admissionState !== 'approved'
                            }
                            onClick={() => {
                              setAsking({ user, action: 'grant' });
                            }}
                          >
                            {t('admin.grant')}
                          </Button>
                        )}
                        <Button
                          disabled={busy}
                          onClick={() => {
                            setAsking({ user, action: 'endSessions' });
                          }}
                        >
                          {t('admin.endSessions')}
                        </Button>
                        {user.admissionState !== 'approved' && (
                          <>
                            <Button
                              disabled={busy}
                              onClick={() => {
                                setAsking({ user, action: 'approve' });
                              }}
                            >
                              {t('admin.approve')}
                            </Button>
                            {user.admissionState === 'pending' && (
                              <Button
                                variant="dangerQuiet"
                                disabled={busy}
                                onClick={() => {
                                  setAsking({ user, action: 'deny' });
                                }}
                              >
                                {t('admin.deny')}
                              </Button>
                            )}
                          </>
                        )}
                        {user.admissionState === 'approved' &&
                          !user.isServerAdmin &&
                          user.id !== session.user.id &&
                          (user.suspendedAt === null ? (
                            <Button
                              variant="dangerQuiet"
                              disabled={busy}
                              onClick={() => {
                                setAsking({ user, action: 'suspend' });
                              }}
                            >
                              {t('settings.server.accounts.suspend')}
                            </Button>
                          ) : (
                            <Button
                              disabled={busy}
                              onClick={() => {
                                void change(user, 'restore');
                              }}
                            >
                              {t('settings.server.accounts.lift')}
                            </Button>
                          ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SettingsCard>
            <Pagination
              pages={pages}
              nextCursor={data.nextCursor}
              busy={query.isFetching || busy}
            />
          </>
        )}
      </QueryState>
      <Dialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setAsking(null);
            setFailure(null);
          }
        }}
        title={t('admin.confirmTitle')}
        description={
          asking === null
            ? ''
            : t(
                asking.action === 'approve'
                  ? 'admin.confirmApprove'
                  : asking.action === 'deny'
                    ? 'admin.confirmDeny'
                    : asking.action === 'grant'
                      ? 'admin.confirmGrant'
                      : asking.action === 'revoke'
                        ? 'admin.confirmRevoke'
                        : asking.action === 'endSessions'
                          ? 'admin.confirmSessions'
                          : 'admin.confirmSuspend',
                { name: asking.user.displayName },
              )
        }
        closeLabel={t('common.close')}
        footer={
          <>
            <Button
              disabled={busy}
              onClick={() => {
                setAsking(null);
                setFailure(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={() => {
                if (asking !== null) void change(asking.user, asking.action);
              }}
            >
              {t('admin.confirm')}
            </Button>
          </>
        }
      >
        {failure !== null && <ChangeFailure failure={failure} />}
      </Dialog>
      {selected !== null && (
        <UserDetail
          id={selected.id}
          onClose={() => {
            setSelected(null);
          }}
        />
      )}
    </>
  );
};

const UserDetail = ({
  id,
  onClose,
}: {
  readonly id: string;
  readonly onClose: () => void;
}): React.JSX.Element => {
  const client = useAdministrationClient();
  const { t, format } = useI18n();
  const pages = usePages();
  const query = useQuery({
    queryKey: ['server', 'user', id, pages.after],
    queryFn: async ({ signal }) => await client.user(id, pages.after, signal),
    retry: false,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('admin.details')}
      description={t('admin.users.body')}
      closeLabel={t('common.close')}
    >
      <QueryState query={query}>
        {(data) => (
          <>
            <h2 className="text-heading text-ink break-words">{data.user.displayName}</h2>
            <Facts
              items={[
                [t('admin.created'), format.absolute(data.user.createdAt)],
                [
                  t('admin.lastSeen'),
                  data.user.lastSeenAt === null
                    ? t('admin.never')
                    : format.absolute(data.user.lastSeenAt),
                ],
                [t('admin.sessions'), data.activeSessions],
              ]}
            />
            <h3 className="text-heading text-ink">{t('admin.memberships')}</h3>
            {data.memberships.length === 0 ? (
              <Empty />
            ) : (
              <ul>
                {data.memberships.map((m) => (
                  <li key={m.workspaceId} className="py-2 text-body text-ink break-words">
                    {m.workspaceName} · {t(`members.role.${m.role}`)}
                  </li>
                ))}
              </ul>
            )}
            <Pagination pages={pages} nextCursor={data.nextCursor} busy={query.isFetching} />
          </>
        )}
      </QueryState>
    </Dialog>
  );
};
