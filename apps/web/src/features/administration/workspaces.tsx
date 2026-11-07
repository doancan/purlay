import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ServerWorkspace, ServerWorkspacesQuery } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { Select } from '../../ui/select';
import { TextField } from '../../ui/text-field';
import { SettingsCard } from '../settings/page';
import { ChangeFailure } from '../settings/server-parts';
import { useAdministrationClient } from './context';
import { Empty, Facts, Pagination, QueryState, usePages } from './parts';

export const Workspaces = ({
  dataOnly = false,
}: {
  readonly dataOnly?: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<ServerWorkspacesQuery['status']>();
  const [filter, setFilter] = useState<ServerWorkspacesQuery>({});
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
            label={t('admin.workspaceSearch')}
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
              if (value === '' || value === 'active' || value === 'deleted' || value === 'full')
                setStatus(value || undefined);
            }}
          >
            <option value="">{t('admin.all')}</option>
            <option value="active">{t('admin.active')}</option>
            <option value="deleted">{t('admin.deleted')}</option>
            <option value="full">{t('admin.full')}</option>
          </Select>
        </label>
        <Button type="submit">{t('admin.find')}</Button>
      </form>
      <WorkspaceList key={JSON.stringify(filter)} filter={filter} dataOnly={dataOnly} />
    </>
  );
};
const WorkspaceList = ({
  filter,
  dataOnly,
}: {
  readonly filter: ServerWorkspacesQuery;
  readonly dataOnly: boolean;
}): React.JSX.Element => {
  const client = useAdministrationClient();
  const { t, format } = useI18n();
  const pages = usePages();
  const query = useQuery({
    queryKey: ['server', 'workspaces', filter, pages.after],
    queryFn: async ({ signal }) =>
      await client.workspaces(
        { ...filter, ...(pages.after === undefined ? {} : { after: pages.after }) },
        signal,
      ),
    retry: false,
  });
  const [editing, setEditing] = useState<ServerWorkspace | null>(null);
  const [granting, setGranting] = useState<ServerWorkspace | null>(null);
  return (
    <QueryState query={query}>
      {(data) => (
        <>
          {data.data.length === 0 && <Empty />}
          {data.data.map((workspace) => (
            <SettingsCard
              key={workspace.id}
              title={workspace.name}
              description={`/${workspace.slug}`}
              actions={
                workspace.deletedAt === null && !dataOnly ? (
                  <>
                    <Button
                      onClick={() => {
                        setGranting(workspace);
                      }}
                    >
                      {t('admin.modulesEdit')}
                    </Button>
                    <Button
                      onClick={() => {
                        setEditing(workspace);
                      }}
                    >
                      {t('admin.quotaEdit')}
                    </Button>
                  </>
                ) : undefined
              }
            >
              <Facts
                items={[
                  [
                    t('admin.status'),
                    t(workspace.deletedAt === null ? 'admin.active' : 'admin.deleted'),
                  ],
                  ...(!dataOnly
                    ? ([
                        [
                          t('admin.owners'),
                          workspace.owners.map((owner) => owner.displayName).join(', ') ||
                            t('admin.none'),
                        ],
                        [t('admin.ownerCount'), workspace.ownerCount],
                        [t('admin.members'), workspace.memberCount],
                      ] as const)
                    : []),
                  [
                    t('admin.used'),
                    <span title={`${workspace.usedBytes} B`}>
                      {format.bytes(Number(workspace.usedBytes))}
                    </span>,
                  ],
                  [
                    t('admin.quota'),
                    <span title={`${workspace.quotaBytes} B`}>
                      {format.bytes(Number(workspace.quotaBytes))}
                    </span>,
                  ],
                  [
                    t('admin.retention'),
                    workspace.retentionDays === null
                      ? t('admin.forever')
                      : t('admin.days', { count: workspace.retentionDays }),
                  ],
                ]}
              />
            </SettingsCard>
          ))}
          <Pagination pages={pages} nextCursor={data.nextCursor} busy={query.isFetching} />
          {granting !== null && (
            <ModulesForm
              key={granting.id}
              workspace={granting}
              onClose={() => {
                setGranting(null);
              }}
            />
          )}
          {editing !== null && (
            <QuotaForm
              key={editing.id}
              workspace={editing}
              onClose={() => {
                setEditing(null);
              }}
            />
          )}
        </>
      )}
    </QueryState>
  );
};
const QuotaForm = ({
  workspace,
  onClose,
}: {
  readonly workspace: ServerWorkspace;
  readonly onClose: () => void;
}): React.JSX.Element => {
  const client = useAdministrationClient();
  const { t } = useI18n();
  const queries = useQueryClient();
  const [value, setValue] = useState(workspace.quotaBytes);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [tried, setTried] = useState(false);
  const bytes = Number(value);
  const valid = /^\d{1,16}$/.test(value) && Number.isSafeInteger(bytes) && bytes >= 0;
  const save = async (): Promise<void> => {
    setTried(true);
    if (!valid || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await client.quota(workspace.id, bytes);
      onClose();
    } catch (error) {
      setFailure(error);
    } finally {
      await queries.invalidateQueries({ queryKey: ['server'] });
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={t('admin.quotaEdit')}
      description={workspace.name}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={() => {
              void save();
            }}
          >
            {t('admin.save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <TextField
          label={t('admin.quotaBytes')}
          hint={t('admin.quotaHint')}
          inputMode="numeric"
          readOnly={busy}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
          {...(tried && !valid ? { error: t('admin.quotaError') } : {})}
        />
        {failure !== null && <ChangeFailure failure={failure} />}
      </form>
    </Dialog>
  );
};

type ModuleChoice = ServerWorkspace['modules'][number]['state'];

/** What the operator says of each module a workspace can be granted (D-292); only what differs from the row is sent. */
const ModulesForm = ({
  workspace,
  onClose,
}: {
  readonly workspace: ServerWorkspace;
  readonly onClose: () => void;
}): React.JSX.Element => {
  const client = useAdministrationClient();
  const { t } = useI18n();
  const queries = useQueryClient();
  const [chosen, setChosen] = useState<Readonly<Record<string, ModuleChoice>>>(() =>
    Object.fromEntries(workspace.modules.map((entry) => [entry.module, entry.state])),
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      for (const entry of workspace.modules) {
        const state = chosen[entry.module] ?? entry.state;
        if (state !== entry.state)
          await client.workspaceModule(workspace.id, { module: entry.module, state });
      }
      onClose();
    } catch (error) {
      setFailure(error);
    } finally {
      await queries.invalidateQueries({ queryKey: ['server'] });
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={t('admin.modulesEdit')}
      description={workspace.name}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={() => {
              void save();
            }}
          >
            {t('admin.modulesSave')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {workspace.modules.map((entry) => (
          <label key={entry.module} className="flex flex-col gap-1 text-label text-ink">
            {entry.module}
            <Select
              value={chosen[entry.module] ?? entry.state}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'on' || value === 'off' || value === 'inherit')
                  setChosen({ ...chosen, [entry.module]: value });
              }}
            >
              <option value="inherit">{t('admin.moduleInherit')}</option>
              <option value="on">{t('admin.moduleOn')}</option>
              <option value="off">{t('admin.moduleOff')}</option>
            </Select>
          </label>
        ))}
        <p className="text-caption text-ink-muted">{t('admin.modulesHint')}</p>
        {failure !== null && <ChangeFailure failure={failure} />}
      </form>
    </Dialog>
  );
};
