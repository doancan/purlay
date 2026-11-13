/** Native directory setup preserves exact company identity mappings and never caches bearer secrets. */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Value } from '@sinclair/typebox/value';
import {
  CreateWorkspaceDirectoryRequest,
  WORKSPACE_DIRECTORIES_MAX,
  RotateDirectoryCredentialRequest,
  type WorkspaceDirectory,
  type DirectoryCredential,
  type IssuedDirectoryCredential,
  type DirectoryIdentityClaim,
} from '@purlay/types/workspace-directory';
import { useApi } from '../../../data/api-provider';
import { useI18n } from '../../../i18n/i18n-provider';
import { Link } from '../../../router/router-provider';
import { Button, buttonStyle } from '../../../ui/button';
import { Checkbox } from '../../../ui/checkbox';
import { Dialog } from '../../../ui/dialog';
import { Select } from '../../../ui/select';
import { TextField } from '../../../ui/text-field';
import { SettingsCard, SettingsPage } from '../page';
import { useWorkspace } from '../../shell/workspace';
import { SecretValue } from '../security/parts';
import { systemClock } from '../../../system-clock';
import {
  AccessConfirm,
  AccessListState,
  AccessProblem,
  More,
  useAccessList,
  useAccessScope,
  useAccessTask,
} from './shared';

export const WorkspaceDirectoriesPage = (): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { workspaceId } = useAccessScope();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useAccessList(['directories'], (query, signal) =>
    api.workspaceDirectories(workspaceId, query, signal),
  );
  const items = list.data?.pages.flatMap((page) => page.data) ?? [];
  const chosen = items.find((item) => item.id === selected);
  return (
    <SettingsPage
      title={t('directory.title')}
      description={t('directory.description')}
      action={
        <Button
          variant="primary"
          disabled={list.isError || list.isPaused || items.length >= WORKSPACE_DIRECTORIES_MAX}
          onClick={() => {
            setCreating(true);
          }}
        >
          {t('directory.create')}
        </Button>
      }
    >
      <SettingsCard title={t('directory.title')} description={t('directory.providerHint')}>
        <AccessListState
          pending={list.isPending}
          failed={list.isError}
          paused={list.isPaused}
          empty={items.length === 0}
          retry={() => {
            void list.refetch();
          }}
        >
          <ul>
            {items.map((directory) => (
              <li
                key={directory.id}
                className="flex items-center justify-between gap-3 border-t-hairline border-border-subtle px-6 py-4 max-narrow:flex-col max-narrow:items-start max-narrow:px-4"
              >
                <div className="min-w-0">
                  <h3 className="break-words text-heading text-ink">{directory.name}</h3>
                  <p className="text-body text-ink-muted">
                    {t(directory.enabled ? 'directory.enabled' : 'directory.disabled')}
                  </p>
                </div>
                <Button
                  aria-expanded={directory.id === selected}
                  onClick={() => {
                    setSelected(directory.id === selected ? null : directory.id);
                  }}
                >
                  {t('directory.manage')}
                </Button>
              </li>
            ))}
          </ul>
          <More
            more={list.hasNextPage}
            busy={list.isFetchingNextPage}
            load={() => {
              void list.fetchNextPage();
            }}
          />
        </AccessListState>
      </SettingsCard>
      {creating && (
        <DirectoryEditor
          directory={null}
          close={() => {
            setCreating(false);
          }}
        />
      )}
      {chosen !== undefined && (
        <DirectoryDetail
          key={chosen.id}
          directory={chosen}
          blocked={list.isError || list.isPaused}
        />
      )}
    </SettingsPage>
  );
};

const DirectoryEditor = ({
  directory,
  close,
}: {
  readonly directory: WorkspaceDirectory | null;
  readonly close: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { workspace } = useWorkspace();
  const { workspaceId, queryKey } = useAccessScope();
  const [name, setName] = useState(directory?.name ?? '');
  const [connectionId, setConnectionId] = useState(directory?.connectionId ?? '');
  const [claim, setClaim] = useState<DirectoryIdentityClaim>(directory?.claim ?? 'sub');
  const [allowCreate, setAllowCreate] = useState(directory?.allowCreate ?? false);
  const [invalid, setInvalid] = useState(false);
  const task = useAccessTask();
  const providers = useQuery({
    queryKey: [...queryKey, 'directory-providers'],
    queryFn: async ({ signal }) => await api.companyConnections(workspaceId, signal),
    enabled: directory === null,
  });
  const choices =
    providers.data?.data.filter((connection) => connection.ready && connection.enabled) ?? [];
  const submit = (): void => {
    const input = { name: name.trim(), connectionId, claim, allowCreate };
    if (
      !Value.Check(CreateWorkspaceDirectoryRequest, input) ||
      (directory === null && choices.every((choice) => choice.id !== connectionId))
    ) {
      setInvalid(true);
      return;
    }
    task.run(
      () =>
        directory === null
          ? api.createWorkspaceDirectory(workspaceId, input)
          : api.updateWorkspaceDirectory(workspaceId, directory.id, {
              revision: directory.revision,
              name: input.name,
              allowCreate,
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
      title={t(directory === null ? 'directory.create' : 'directory.edit')}
      description={t('directory.mappingHint')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button disabled={task.busy} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={task.busy}
            disabled={
              directory === null &&
              (providers.isError || providers.isPaused || choices.length === 0)
            }
            onClick={submit}
          >
            {t('access.save')}
          </Button>
        </>
      }
    >
      <fieldset disabled={task.busy} className="flex min-w-0 flex-col gap-4">
        <TextField
          label={t('access.name')}
          value={name}
          maxLength={64}
          onChange={(event) => {
            setName(event.currentTarget.value);
            setInvalid(false);
          }}
        />
        {directory === null && (
          <>
            <AccessListState
              pending={providers.isPending}
              failed={providers.isError}
              paused={providers.isPaused}
              empty={false}
              retry={() => {
                void providers.refetch();
              }}
            >
              <label className="flex flex-col gap-2 text-label text-ink">
                {t('directory.connection')}
                <Select
                  value={connectionId}
                  onChange={(event) => {
                    setConnectionId(event.currentTarget.value);
                  }}
                >
                  <option value="">{t('directory.chooseConnection')}</option>
                  {choices.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name}
                    </option>
                  ))}
                </Select>
              </label>
              {choices.length === 0 && (
                <Link
                  to="settings"
                  params={{ slug: workspace.slug, section: 'company' }}
                  className={buttonStyle('secondary')}
                >
                  {t('directory.configureCompany')}
                </Link>
              )}
            </AccessListState>
            <label className="flex flex-col gap-2 text-label text-ink">
              {t('directory.claim')}
              <Select
                value={claim}
                onChange={(event) => {
                  setClaim(event.currentTarget.value === 'oid' ? 'oid' : 'sub');
                }}
              >
                <option value="sub">{t('directory.claim.sub')}</option>
                <option value="oid">{t('directory.claim.oid')}</option>
              </Select>
            </label>
          </>
        )}
        <label className="flex items-start gap-3 text-body text-ink">
          <Checkbox
            checked={allowCreate}
            onChange={(event) => {
              setAllowCreate(event.currentTarget.checked);
            }}
          />
          {t('directory.allowCreate')}
        </label>
      </fieldset>
      <AccessProblem text={invalid ? t('directory.invalid') : task.problem} />
    </Dialog>
  );
};

const DirectoryDetail = ({
  directory,
  blocked,
}: {
  readonly directory: WorkspaceDirectory;
  readonly blocked: boolean;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const api = useApi();
  const { workspaceId, queryKey } = useAccessScope();
  const [editing, setEditing] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [revoking, setRevoking] = useState<DirectoryCredential | null>(null);
  const [issued, setIssued] = useState<IssuedDirectoryCredential | null>(null);
  const task = useAccessTask();
  const providers = useQuery({
    queryKey: [...queryKey, 'directory-providers'],
    queryFn: async ({ signal }) => await api.companyConnections(workspaceId, signal),
  });
  const providerName =
    providers.data?.data.find((provider) => provider.id === directory.connectionId)?.name ??
    t('directory.unavailableConnection');
  const previousRevision = useRef(directory.revision);
  useEffect(() => {
    if (
      previousRevision.current !== directory.revision &&
      issued !== null &&
      issued.directory.revision !== directory.revision
    )
      setIssued(null);
    previousRevision.current = directory.revision;
  }, [directory.revision, issued]);
  return (
    <>
      <SettingsCard title={directory.name} description={t('directory.mappingHint')}>
        <div className="flex min-w-0 flex-col gap-4 px-6 py-5 max-narrow:px-4">
          <p className="text-body text-ink">
            {providerName} ·{' '}
            {t(directory.claim === 'sub' ? 'directory.claim.sub' : 'directory.claim.oid')}
          </p>
          <p className="text-body text-ink-muted">
            {t(directory.allowCreate ? 'directory.creates' : 'directory.existingOnly')}
          </p>
          <SecretValue label={t('directory.url')} value={directory.scimUrl} />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={blocked || task.busy}
              onClick={() => {
                setIssued(null);
                setEditing(true);
              }}
            >
              {t('directory.edit')}
            </Button>
            <Button
              disabled={blocked || task.busy}
              onClick={() => {
                setIssued(null);
                task.clear();
                setDisabling(true);
              }}
            >
              {t(directory.enabled ? 'directory.disable' : 'directory.enable')}
            </Button>
            <Button
              variant="dangerQuiet"
              disabled={blocked || task.busy}
              onClick={() => {
                setIssued(null);
                task.clear();
                setRemoving(true);
              }}
            >
              {t('directory.remove')}
            </Button>
          </div>
        </div>
      </SettingsCard>
      <SettingsCard
        title={t('directory.credentials')}
        description={t('directory.credentialHint')}
        actions={
          <Button
            disabled={blocked || !directory.enabled || task.busy}
            onClick={() => {
              setIssued(null);
              setRotating(true);
            }}
          >
            {t('directory.rotate')}
          </Button>
        }
      >
        {directory.credentials.length === 0 ? (
          <p className="px-6 py-5 text-body text-ink-muted max-narrow:px-4">
            {t('directory.noCredentials')}
          </p>
        ) : (
          <ul>
            {directory.credentials.map((credential) => (
              <CredentialRow
                key={credential.id}
                credential={credential}
                blocked={blocked || task.busy}
                revoke={() => {
                  setIssued(null);
                  task.clear();
                  setRevoking(credential);
                }}
              />
            ))}
          </ul>
        )}
      </SettingsCard>
      {editing && (
        <DirectoryEditor
          directory={directory}
          close={() => {
            setEditing(false);
          }}
        />
      )}
      {rotating && (
        <RotateCredential
          directory={directory}
          close={() => {
            setRotating(false);
          }}
          accept={(result) => {
            setIssued(result);
            setRotating(false);
          }}
        />
      )}
      {issued !== null && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setIssued(null);
          }}
          title={t('directory.tokenTitle')}
          description={t('directory.tokenHint')}
          closeLabel={t('common.close')}
          focusFirst="dialog"
          footer={
            <Button
              variant="primary"
              onClick={() => {
                setIssued(null);
              }}
            >
              {t('directory.tokenSaved')}
            </Button>
          }
        >
          <SecretValue label={t('directory.token')} value={issued.token} />
          <p className="text-body text-ink-muted">
            {t('directory.expires', { date: format.absolute(issued.credential.expiresAt) })}
          </p>
        </Dialog>
      )}
      {disabling && (
        <AccessConfirm
          title={t(directory.enabled ? 'directory.disable' : 'directory.enable')}
          description={t('directory.toggleHint')}
          confirm={t(directory.enabled ? 'directory.disable' : 'directory.enable')}
          danger={directory.enabled}
          busy={task.busy}
          problem={task.problem}
          close={() => {
            setDisabling(false);
          }}
          act={() => {
            task.run(
              () =>
                api.updateWorkspaceDirectory(workspaceId, directory.id, {
                  revision: directory.revision,
                  enabled: !directory.enabled,
                }),
              () => {
                setDisabling(false);
              },
            );
          }}
        />
      )}
      {removing && (
        <AccessConfirm
          title={t('directory.removeTitle', { name: directory.name })}
          description={t('directory.removeHint')}
          confirm={t('directory.remove')}
          busy={task.busy}
          problem={task.problem}
          close={() => {
            setRemoving(false);
          }}
          act={() => {
            task.run(
              () =>
                api.deleteWorkspaceDirectory(workspaceId, directory.id, {
                  revision: directory.revision,
                }),
              () => {
                setRemoving(false);
              },
            );
          }}
        />
      )}
      {revoking !== null && (
        <AccessConfirm
          title={t('directory.revoke')}
          description={t('directory.revokeHint')}
          confirm={t('directory.revoke')}
          busy={task.busy}
          problem={task.problem}
          close={() => {
            setRevoking(null);
          }}
          act={() => {
            task.run(
              () =>
                api.revokeDirectoryCredential(workspaceId, directory.id, {
                  revision: directory.revision,
                  credentialId: revoking.id,
                }),
              () => {
                setRevoking(null);
              },
            );
          }}
        />
      )}
    </>
  );
};

const RotateCredential = ({
  directory,
  close,
  accept,
}: {
  readonly directory: WorkspaceDirectory;
  readonly close: () => void;
  readonly accept: (issued: IssuedDirectoryCredential) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { workspaceId } = useAccessScope();
  const [days, setDays] = useState(90);
  const [overlap, setOverlap] = useState(0);
  const [invalid, setInvalid] = useState(false);
  const task = useAccessTask();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !task.busy) close();
      }}
      title={t('directory.rotate')}
      description={t('directory.rotateHint')}
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
              const input = {
                revision: directory.revision,
                expiresInDays: days,
                overlapMinutes: overlap,
              };
              if (!Value.Check(RotateDirectoryCredentialRequest, input)) {
                setInvalid(true);
                return;
              }
              task.run(async () => {
                const result = await api.rotateDirectoryCredential(
                  workspaceId,
                  directory.id,
                  input,
                );
                accept(result);
              });
            }}
          >
            {t('directory.issue')}
          </Button>
        </>
      }
    >
      <fieldset disabled={task.busy} className="flex min-w-0 flex-col gap-4">
        <TextField
          type="number"
          min={1}
          max={365}
          label={t('directory.days')}
          value={days}
          onChange={(event) => {
            setDays(Number(event.currentTarget.value));
            setInvalid(false);
          }}
        />
        <TextField
          type="number"
          min={0}
          max={1440}
          label={t('directory.overlap')}
          hint={t('directory.overlapHint')}
          value={overlap}
          onChange={(event) => {
            setOverlap(Number(event.currentTarget.value));
            setInvalid(false);
          }}
        />
      </fieldset>
      <AccessProblem text={invalid ? t('directory.rotateInvalid') : task.problem} />
    </Dialog>
  );
};

const CredentialRow = ({
  credential,
  blocked,
  revoke,
}: {
  readonly credential: DirectoryCredential;
  readonly blocked: boolean;
  readonly revoke: () => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const expired = Date.parse(credential.expiresAt) <= systemClock.now().getTime();
  return (
    <li className="flex items-start justify-between gap-3 border-t-hairline border-border-subtle px-6 py-4 max-narrow:flex-col max-narrow:px-4">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-label text-ink">
          {t('directory.credentialCreated', { date: format.absolute(credential.createdAt) })}
        </p>
        <p className="text-body text-ink-muted">
          {credential.revokedAt !== null
            ? t('directory.revoked', { date: format.absolute(credential.revokedAt) })
            : t(expired ? 'directory.expired' : 'directory.expires', {
                date: format.absolute(credential.expiresAt),
              })}
        </p>
        <p className="text-body text-ink-muted">
          {credential.lastUsedAt === null
            ? t('directory.neverUsed')
            : t('directory.lastUsed', { date: format.absolute(credential.lastUsedAt) })}
        </p>
      </div>
      {credential.revokedAt === null && !expired && (
        <Button variant="dangerQuiet" disabled={blocked} onClick={revoke}>
          {t('directory.revoke')}
        </Button>
      )}
    </li>
  );
};
