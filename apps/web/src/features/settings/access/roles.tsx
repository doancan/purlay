/** Finite custom roles delegate operational actions without changing native owner/admin powers. */
import { useState } from 'react';
import { Value } from '@sinclair/typebox/value';
import {
  CreateWorkspaceAccessRoleRequest,
  WORKSPACE_ACCESS_ACTIONS,
  CHANNEL_ACCESS_ACTIONS,
  type WorkspaceAccessRole,
  type WorkspaceScopedCapability,
} from '@purlay/types/workspace-provisioning';
import { useApi } from '../../../data/api-provider';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { Checkbox } from '../../../ui/checkbox';
import { Dialog } from '../../../ui/dialog';
import { TextField } from '../../../ui/text-field';
import { SettingsCard, SettingsPage } from '../page';
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

export const AccessRolesPage = (): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { workspaceId } = useAccessScope();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<WorkspaceAccessRole | 'new' | null>(null);
  const [retiring, setRetiring] = useState<WorkspaceAccessRole | null>(null);
  const task = useAccessTask();
  const roles = useAccessList(['roles', search], (query, signal) =>
    api.workspaceAccessRoles(workspaceId, { ...query, q: search }, signal),
  );
  const items = roles.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <SettingsPage
      title={t('access.roles.title')}
      description={t('access.roles.description')}
      action={
        <Button
          variant="primary"
          disabled={roles.isError || roles.isPaused}
          onClick={() => {
            setEditing('new');
          }}
        >
          {t('access.roles.create')}
        </Button>
      }
    >
      <SettingsCard description={t('access.roles.boundary')} title={t('access.roles.title')}>
        <div className="p-4">
          <AccessSearch value={search} change={setSearch} />
        </div>
        <AccessListState
          pending={roles.isPending}
          failed={roles.isError}
          paused={roles.isPaused}
          empty={items.length === 0}
          retry={() => {
            void roles.refetch();
          }}
        >
          <ul>
            {items.map((role) => (
              <li
                key={role.id}
                className="flex items-start justify-between gap-4 border-t-hairline border-border-subtle px-6 py-4 max-narrow:flex-col max-narrow:px-4"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <h3 className="break-words text-heading text-ink">{role.name}</h3>
                  <CapabilityList capabilities={role.capabilities} />
                  {role.retiredAt !== null && (
                    <p className="text-label text-ink-muted">{t('access.retired')}</p>
                  )}
                </div>
                {role.retiredAt === null && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={roles.isError || roles.isPaused}
                      onClick={() => {
                        setEditing(role);
                      }}
                    >
                      {t('access.edit')}
                    </Button>
                    <Button
                      variant="dangerQuiet"
                      disabled={roles.isError || roles.isPaused}
                      onClick={() => {
                        task.clear();
                        setRetiring(role);
                      }}
                    >
                      {t('access.retire')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <More
            more={roles.hasNextPage}
            busy={roles.isFetchingNextPage}
            load={() => {
              void roles.fetchNextPage();
            }}
          />
        </AccessListState>
      </SettingsCard>
      {editing !== null && (
        <RoleEditor
          key={editing === 'new' ? 'new' : editing.revision}
          role={editing === 'new' ? null : editing}
          close={() => {
            setEditing(null);
          }}
        />
      )}
      {retiring !== null && (
        <AccessConfirm
          title={t('access.roles.retireTitle', { name: retiring.name })}
          description={t('access.roles.retireHint')}
          confirm={t('access.retire')}
          busy={task.busy}
          problem={task.problem}
          close={() => {
            setRetiring(null);
          }}
          act={() => {
            task.run(
              () =>
                api.retireWorkspaceAccessRole(workspaceId, retiring.id, {
                  revision: retiring.revision,
                }),
              () => {
                setRetiring(null);
              },
            );
          }}
        />
      )}
    </SettingsPage>
  );
};

const RoleEditor = ({
  role,
  close,
}: {
  readonly role: WorkspaceAccessRole | null;
  readonly close: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { workspaceId } = useAccessScope();
  const task = useAccessTask();
  const [name, setName] = useState(role?.name ?? '');
  const [capabilities, setCapabilities] = useState<WorkspaceScopedCapability[]>(
    role?.capabilities ?? [],
  );
  const [invalid, setInvalid] = useState(false);
  const submit = (): void => {
    const input = { name: name.trim(), capabilities };
    if (!Value.Check(CreateWorkspaceAccessRoleRequest, input)) {
      setInvalid(true);
      return;
    }
    task.run(
      () =>
        role === null
          ? api.createWorkspaceAccessRole(workspaceId, input)
          : api.updateWorkspaceAccessRole(workspaceId, role.id, {
              ...input,
              revision: role.revision,
            }),
      close,
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !task.busy) close();
      }}
      title={t(role === null ? 'access.roles.create' : 'access.roles.edit')}
      description={t('access.roles.boundary')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button disabled={task.busy} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={task.busy} onClick={submit}>
            {t('access.save')}
          </Button>
        </>
      }
    >
      <fieldset disabled={task.busy} className="flex min-w-0 flex-col gap-4">
        <TextField
          label={t('access.name')}
          maxLength={64}
          value={name}
          onChange={(event) => {
            setName(event.currentTarget.value);
            setInvalid(false);
          }}
        />
        {(
          [
            ['workspace', WORKSPACE_ACCESS_ACTIONS],
            ['channel', CHANNEL_ACCESS_ACTIONS],
          ] as const
        ).map(([scope, actions]) => (
          <fieldset key={scope} className="flex flex-col gap-3">
            <legend className="mb-2 text-label text-ink">
              {t(scope === 'workspace' ? 'access.workspaceScope' : 'access.channelScope')}
            </legend>
            {actions.map((action) => (
              <label key={action} className="flex items-start gap-3 text-body text-ink">
                <Checkbox
                  checked={capabilities.includes(action)}
                  onChange={(event) => {
                    setCapabilities(
                      event.currentTarget.checked
                        ? [...capabilities, action]
                        : capabilities.filter((capability) => capability !== action),
                    );
                    setInvalid(false);
                  }}
                />
                {t(`access.capability.${action}`)}
              </label>
            ))}
          </fieldset>
        ))}
      </fieldset>
      <AccessProblem text={invalid ? t('access.roles.invalid') : task.problem} />
    </Dialog>
  );
};
