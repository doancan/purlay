import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SERVER_APPROVAL_BATCH_MAX, type ServerUser, type ServerUsersQuery } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { TextField } from '../../ui/text-field';
import { Select } from '../../ui/select';
import { Dialog } from '../../ui/dialog';
import { Checkbox } from '../../ui/checkbox';
import { SettingsCard } from '../settings/page';
import { ChangeFailure } from '../settings/server-parts';
import { useServerClient } from '../settings/server-context';
import { useSession } from '../session/session';
import { keys } from '../../data/keys';
import { useAdministrationClient } from './context';
import { Empty, Facts, Pagination, QueryState, usePages } from './parts';
import { BatchApprovals } from './batch-approvals';

type AccountAction = 'grant' | 'revoke' | 'endSessions' | 'suspend' | 'approve' | 'deny';
export const Users = (): React.JSX.Element => {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<ServerUsersQuery['status']>();
  const [filter, setFilter] = useState<ServerUsersQuery>({});
  const [working, setWorking] = useState(false);
  return (
    <>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter({ q: q.trim(), ...(status === undefined ? {} : { status }) });
        }}
      >
        <div className="min-w-0 flex-1 max-narrow:basis-full">
          <TextField
            label={t('admin.search')}
            value={q}
            readOnly={working}
            maxLength={100}
            onChange={(event) => {
              setQ(event.target.value);
            }}
          />
        </div>
        <label className="flex flex-col gap-1 text-label text-ink">
          {t('admin.status')}
          <Select
            disabled={working}
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
        <Button type="submit" disabled={working}>
          {t('admin.find')}
        </Button>
      </form>
      <UserList key={JSON.stringify(filter)} filter={filter} onBusy={setWorking} />
    </>
  );
};

/** Why an account cannot be made an administrator yet, or null when it can. */
const grantBlocked = (
  user: ServerUser,
):
  | 'admin.grant.blocked.suspended'
  | 'admin.grant.blocked.unverified'
  | 'admin.grant.blocked.unapproved'
  | null =>
  user.suspendedAt !== null
    ? 'admin.grant.blocked.suspended'
    : !user.emailVerified
      ? 'admin.grant.blocked.unverified'
      : user.admissionState !== 'approved'
        ? 'admin.grant.blocked.unapproved'
        : null;

/**
 * One account: a checkbox for a pending one in its own leading column, who it is, then what can be done to it,
 * the state's own decision (approve, deny) first. A grant the account cannot take yet is disabled, and the reason
 * is said under the buttons and tied to the button — a pointer that never hovers, a finger, never sees a tip —
 * on a line of its own, so it does not sit between two buttons as if it were one.
 */
const AccountRow = ({
  user,
  busy,
  self,
  selection,
  selectColumn,
  onDetails,
  onAsk,
  onRestore,
}: {
  readonly user: ServerUser;
  readonly busy: boolean;
  readonly self: boolean;
  readonly selection: {
    readonly checked: boolean;
    readonly disabled: boolean;
    readonly onChange: (checked: boolean) => void;
  } | null;
  /** Some row in the list can be selected: one that cannot keeps the column empty, so every name starts on one edge. */
  readonly selectColumn: boolean;
  readonly onDetails: () => void;
  readonly onAsk: (action: AccountAction) => void;
  readonly onRestore: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const blocked = grantBlocked(user);
  const describedBy = `account-${user.id}`;
  const reasonId = `grant-why-${user.id}`;
  const status =
    user.admissionState !== 'approved'
      ? t(`admin.${user.admissionState}`)
      : user.isServerAdmin
        ? t('settings.server.accounts.admin')
        : user.suspendedAt === null
          ? t('admin.active')
          : t('admin.suspended');
  return (
    <li className="flex items-start gap-3 not-last:border-b-hairline border-border-subtle px-6 py-4 max-narrow:px-4">
      {selection !== null && (
        // The box's hit area is a control's height and centred on the name's line, so it is easy to hit and in line.
        <label className="-m-2 flex shrink-0 cursor-pointer p-2">
          <Checkbox
            aria-label={t('admin.bulk.select', { name: user.displayName })}
            aria-describedby={describedBy}
            checked={selection.checked}
            disabled={selection.disabled}
            onChange={(event) => {
              selection.onChange(event.target.checked);
            }}
          />
        </label>
      )}
      {selection === null && selectColumn && (
        <span aria-hidden="true" className="size-icon-md shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex min-w-0 flex-col">
          <h3 className="text-label text-ink break-words">{user.displayName}</h3>
          <p id={describedBy} className="text-caption text-ink-muted break-all">
            @{user.username} · {user.email}
          </p>
          <p className="text-caption text-ink-muted">
            {status} · {t(user.emailVerified ? 'admin.verified' : 'admin.unverified')}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {user.admissionState !== 'approved' && (
              <Button
                disabled={busy}
                onClick={() => {
                  onAsk('approve');
                }}
              >
                {t('admin.approve')}
              </Button>
            )}
            <Button disabled={busy} onClick={onDetails}>
              {t('admin.details')}
            </Button>
            {user.isServerAdmin ? (
              <Button
                disabled={busy}
                onClick={() => {
                  onAsk('revoke');
                }}
              >
                {t('admin.revoke')}
              </Button>
            ) : (
              <Button
                disabled={busy || blocked !== null}
                onClick={() => {
                  onAsk('grant');
                }}
                {...(blocked === null ? {} : { 'aria-describedby': reasonId })}
              >
                {t('admin.grant')}
              </Button>
            )}
            <Button
              disabled={busy}
              onClick={() => {
                onAsk('endSessions');
              }}
            >
              {t('admin.endSessions')}
            </Button>
            {user.admissionState === 'approved' &&
              !user.isServerAdmin &&
              !self &&
              (user.suspendedAt === null ? (
                <Button
                  variant="dangerQuiet"
                  disabled={busy}
                  onClick={() => {
                    onAsk('suspend');
                  }}
                >
                  {t('settings.server.accounts.suspend')}
                </Button>
              ) : (
                <Button disabled={busy} onClick={onRestore}>
                  {t('settings.server.accounts.lift')}
                </Button>
              ))}
            {user.admissionState === 'pending' && (
              <Button
                variant="dangerQuiet"
                disabled={busy}
                onClick={() => {
                  onAsk('deny');
                }}
              >
                {t('admin.deny')}
              </Button>
            )}
          </div>
          {blocked !== null && !user.isServerAdmin && (
            <p id={reasonId} className="text-caption text-ink-muted">
              {t(blocked)}
            </p>
          )}
        </div>
      </div>
    </li>
  );
};

const UserList = ({
  filter,
  onBusy,
}: {
  readonly filter: ServerUsersQuery;
  readonly onBusy: (busy: boolean) => void;
}): React.JSX.Element => {
  const client = useAdministrationClient();
  const { t } = useI18n();
  const pages = usePages();
  const session = useSession();
  const queries = useQueryClient();
  const providers = useServerClient();
  const query = useQuery({
    queryKey: keys.serverUsers(filter, pages.after),
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
  const [approvals, setApprovals] = useState<ReadonlyMap<string, ServerUser>>(new Map());
  const working = (value: boolean): void => {
    setBusy(value);
    onBusy(value);
    if (value) {
      setFailure(null);
      setOutcome(false);
    }
  };
  const refresh = async (): Promise<void> => {
    await queries.invalidateQueries({ queryKey: keys.server });
    await queries.invalidateQueries({ queryKey: keys.me });
  };
  const change = async (user: ServerUser, action: AccountAction | 'restore'): Promise<void> => {
    if (busy) return;
    working(true);
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
      working(false);
    }
  };
  return (
    <>
      <BatchApprovals
        users={query.data?.data ?? []}
        selected={[...approvals.values()]}
        busy={busy}
        loading={query.isFetching}
        onBusy={working}
        refresh={refresh}
        onSelection={(users) => {
          setApprovals(new Map(users.map((user) => [user.id, user])));
        }}
      />
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
                    <AccountRow
                      key={user.id}
                      user={user}
                      busy={busy}
                      self={user.id === session.user.id}
                      selectColumn={data.data.some(
                        (account) => account.admissionState === 'pending',
                      )}
                      selection={
                        user.admissionState === 'pending'
                          ? {
                              checked: approvals.has(user.id),
                              disabled:
                                busy ||
                                query.isFetching ||
                                (approvals.size >= SERVER_APPROVAL_BATCH_MAX &&
                                  !approvals.has(user.id)),
                              onChange: (checked): void => {
                                setApprovals((held) => {
                                  const next = new Map(held);
                                  if (checked) next.set(user.id, user);
                                  else next.delete(user.id);
                                  return next;
                                });
                              },
                            }
                          : null
                      }
                      onDetails={() => {
                        setSelected(user);
                      }}
                      onAsk={(action) => {
                        setAsking({ user, action });
                      }}
                      onRestore={() => {
                        void change(user, 'restore');
                      }}
                    />
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
    queryKey: keys.serverUser(id, pages.after),
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
            <div className="flex flex-col gap-1">
              <h3 className="text-heading text-ink break-words">{data.user.displayName}</h3>
              <p className="text-caption text-ink-muted break-all">
                @{data.user.username} · {data.user.email}
              </p>
            </div>
            <Facts
              flush
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
            <section className="flex flex-col gap-1">
              <h3 className="text-label text-ink-muted">{t('admin.memberships')}</h3>
              {data.memberships.length === 0 ? (
                // A line, not the page's empty state: in a dialog's section a framed glyph outweighs the facts above it.
                <p role="status" className="py-2 text-body text-ink-muted">
                  {t('admin.empty')}
                </p>
              ) : (
                <ul className="divide-y-hairline divide-border-subtle">
                  {data.memberships.map((m) => (
                    <li
                      key={m.workspaceId}
                      className="flex items-baseline justify-between gap-4 py-2"
                    >
                      <span className="min-w-0 text-body text-ink break-words">
                        {m.workspaceName}
                      </span>
                      <span className="shrink-0 text-caption text-ink-muted">
                        {t(`members.role.${m.role}`)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <Pagination pages={pages} nextCursor={data.nextCursor} busy={query.isFetching} />
          </>
        )}
      </QueryState>
    </Dialog>
  );
};
