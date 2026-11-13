/** Grants attach a role to one existing source/group and one compatible scope; membership is separate. */
import { useState } from 'react';
import type {
  AssignWorkspaceAccessGrantRequest,
  WorkspaceAccessGrant,
  WorkspaceAccessRole,
} from '@purlay/types/workspace-provisioning';
import { useApi } from '../../../data/api-provider';
import { useChannels } from '../../../data/queries';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { Dialog } from '../../../ui/dialog';
import { Radio } from '../../../ui/checkbox';
import { Select } from '../../../ui/select';
import {
  AccessConfirm,
  AccessListState,
  AccessProblem,
  AccessSearch,
  CapabilityList,
  More,
  useAccessList,
  useAccessScope,
  useAccessTask,
} from './shared';

type Subject = AssignWorkspaceAccessGrantRequest['subject'];
export const AccessGrants = ({
  subject,
  revision,
  disabled = false,
}: {
  readonly subject: Subject;
  readonly revision: string;
  readonly disabled?: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { workspaceId } = useAccessScope();
  const id = subject.kind === 'source' ? subject.sourceId : subject.groupId;
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<WorkspaceAccessGrant | null>(null);
  const task = useAccessTask();
  const grants = useAccessList(['grants', subject.kind, id], (query, signal) =>
    api.workspaceAccessGrants(
      workspaceId,
      {
        ...query,
        ...(subject.kind === 'source'
          ? { sourceId: subject.sourceId }
          : { groupId: subject.groupId }),
      },
      signal,
    ),
  );
  const items = grants.data?.pages.flatMap((page) => page.data) ?? [];
  const blocked = disabled || grants.isError || grants.isPaused;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-heading text-ink">{t('access.grants.title')}</h3>
        <Button
          disabled={blocked}
          onClick={() => {
            setAdding(true);
          }}
        >
          {t('access.grants.assign')}
        </Button>
      </div>
      <p className="text-body text-ink-muted">{t('access.grants.membershipHint')}</p>
      <AccessListState
        pending={grants.isPending}
        failed={grants.isError}
        paused={grants.isPaused}
        empty={items.length === 0}
        retry={() => {
          void grants.refetch();
        }}
      >
        <ul className="flex flex-col gap-4">
          {items.map((grant) => (
            <li
              key={grant.id}
              className="flex items-start justify-between gap-3 max-narrow:flex-col"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <p className="break-words text-label text-ink">{grant.role.name}</p>
                <p className="text-body text-ink-muted">
                  {grant.scope.kind === 'workspace'
                    ? t('access.workspaceScope')
                    : `#${grant.scope.name}`}
                </p>
                <CapabilityList
                  capabilities={grant.role.capabilities.filter((action) =>
                    grant.scope.kind === 'channel'
                      ? action.startsWith('channel.')
                      : !action.startsWith('channel.'),
                  )}
                />
              </div>
              <Button
                variant="dangerQuiet"
                disabled={blocked}
                onClick={() => {
                  task.clear();
                  setRemoving(grant);
                }}
              >
                {t('access.grants.revoke')}
              </Button>
            </li>
          ))}
        </ul>
        <More
          more={grants.hasNextPage}
          busy={grants.isFetchingNextPage}
          load={() => {
            void grants.fetchNextPage();
          }}
        />
      </AccessListState>
      {adding && (
        <GrantEditor
          subject={subject}
          revision={revision}
          close={() => {
            setAdding(false);
          }}
        />
      )}
      {removing !== null && (
        <AccessConfirm
          title={t('access.grants.revokeTitle', { name: removing.role.name })}
          description={t('access.grants.revokeHint')}
          confirm={t('access.grants.revoke')}
          busy={task.busy}
          problem={task.problem}
          close={() => {
            setRemoving(null);
          }}
          act={() => {
            task.run(
              () =>
                api.revokeWorkspaceAccessGrant(workspaceId, removing.id, {
                  revision: removing.revision,
                }),
              () => {
                setRemoving(null);
              },
            );
          }}
        />
      )}
    </div>
  );
};

const GrantEditor = ({
  subject,
  revision,
  close,
}: {
  readonly subject: Subject;
  readonly revision: string;
  readonly close: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { workspaceId } = useAccessScope();
  const [search, setSearch] = useState('');
  const [roleId, setRoleId] = useState<string | null>(null);
  const [scope, setScope] = useState<'workspace' | 'channel'>('workspace');
  const [channelId, setChannelId] = useState('');
  const task = useAccessTask();
  const roles = useAccessList(['grant-role-choices', search], (query, signal) =>
    api.workspaceAccessRoles(workspaceId, { ...query, q: search }, signal),
  );
  const channels = useChannels(workspaceId);
  const choices =
    channels.data?.filter(
      (channel) => channel.type !== 'direct_message' && channel.name !== null,
    ) ?? [];
  const items =
    roles.data?.pages.flatMap((page) => page.data).filter((role) => role.retiredAt === null) ?? [];
  const chosen = items.find((role) => role.id === roleId);
  const applicable = (role: WorkspaceAccessRole): WorkspaceAccessRole['capabilities'] =>
    role.capabilities.filter((action) =>
      scope === 'channel' ? action.startsWith('channel.') : !action.startsWith('channel.'),
    );
  const compatible = chosen === undefined ? [] : applicable(chosen);
  const blocked =
    roles.isError ||
    roles.isPaused ||
    (scope === 'channel' &&
      (channels.isError || choices.every((channel) => channel.id !== channelId)));
  const submit = (): void => {
    if (chosen === undefined || compatible.length === 0 || blocked) return;
    task.run(
      () =>
        api.assignWorkspaceAccessGrant(workspaceId, {
          roleId: chosen.id,
          roleRevision: chosen.revision,
          subject,
          subjectRevision: revision,
          scope: scope === 'workspace' ? { kind: 'workspace' } : { kind: 'channel', channelId },
        }),
      close,
    );
  };
  return (
    <Dialog
      open
      size="wide"
      onOpenChange={(open) => {
        if (!open && !task.busy) close();
      }}
      title={t('access.grants.assign')}
      description={t('access.grants.scopeHint')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button disabled={task.busy} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={task.busy}
            disabled={blocked || compatible.length === 0}
            onClick={submit}
          >
            {t('access.grants.assign')}
          </Button>
        </>
      }
    >
      <fieldset disabled={task.busy} className="flex min-w-0 flex-col gap-4">
        <label className="flex flex-col gap-2 text-label text-ink">
          {t('access.grants.scope')}
          <Select
            value={scope}
            onChange={(event) => {
              setScope(event.currentTarget.value === 'channel' ? 'channel' : 'workspace');
            }}
          >
            <option value="workspace">{t('access.workspaceScope')}</option>
            <option value="channel">{t('access.channelScope')}</option>
          </Select>
        </label>
        {scope === 'channel' && (
          <>
            <label className="flex flex-col gap-2 text-label text-ink">
              {t('access.grants.channel')}
              <Select
                value={channelId}
                onChange={(event) => {
                  setChannelId(event.currentTarget.value);
                }}
              >
                <option value="">{t('access.grants.chooseChannel')}</option>
                {choices.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    #{channel.name}
                  </option>
                ))}
              </Select>
            </label>
            {channels.isError && <AccessProblem text={t('access.loadFailed')} />}
          </>
        )}
        <AccessSearch
          value={search}
          change={(value) => {
            setSearch(value);
            setRoleId(null);
          }}
          label={t('access.roles.search')}
        />
        <AccessListState
          pending={roles.isPending}
          failed={roles.isError}
          paused={roles.isPaused}
          empty={items.length === 0}
          retry={() => {
            void roles.refetch();
          }}
        >
          <fieldset className="flex flex-col gap-4">
            <legend className="mb-3 text-label text-ink">{t('access.grants.role')}</legend>
            {items.map((role) => (
              <label key={role.id} className="flex items-start gap-3">
                <Radio
                  name="access-role"
                  checked={roleId === role.id}
                  disabled={applicable(role).length === 0}
                  onChange={() => {
                    setRoleId(role.id);
                  }}
                />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="break-words text-label text-ink">{role.name}</span>
                  <CapabilityList capabilities={applicable(role)} />
                  {applicable(role).length === 0 && (
                    <span className="text-body text-ink-muted">
                      {t('access.grants.incompatible')}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </fieldset>
          <More
            more={roles.hasNextPage}
            busy={roles.isFetchingNextPage}
            load={() => {
              void roles.fetchNextPage();
            }}
          />
        </AccessListState>
      </fieldset>
      <AccessProblem text={task.problem} />
    </Dialog>
  );
};
