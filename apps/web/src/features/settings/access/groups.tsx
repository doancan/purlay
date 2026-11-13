/** Administrative groups bind exact admission sources, separately from personal sidebar folders. */
import { useState } from 'react';
import { Value } from '@sinclair/typebox/value';
import {
  CreateWorkspaceAccessGroupRequest,
  type WorkspaceAccessGroup,
  type WorkspaceAccessGroupMember,
} from '@purlay/types/workspace-provisioning';
import { useApi } from '../../../data/api-provider';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { Checkbox } from '../../../ui/checkbox';
import { Dialog } from '../../../ui/dialog';
import { TextField } from '../../../ui/text-field';
import { Avatar } from '../../../ui/avatar';
import { SettingsCard, SettingsPage } from '../page';
import {
  AccessConfirm,
  AccessListState,
  AccessProblem,
  AccessSearch,
  More,
  sourceName,
  useAccessList,
  useAccessScope,
  useAccessTask,
} from './shared';
import { AccessGrants } from './grants';

export const AccessGroupsPage = (): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { workspaceId } = useAccessScope();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<WorkspaceAccessGroup | 'new' | null>(null);
  const [retiring, setRetiring] = useState<WorkspaceAccessGroup | null>(null);
  const task = useAccessTask();
  const groups = useAccessList(['groups', search], (query, signal) =>
    api.workspaceAccessGroups(workspaceId, { ...query, q: search }, signal),
  );
  const items = groups.data?.pages.flatMap((page) => page.data) ?? [];
  const chosen = items.find((group) => group.id === selected);
  const blocked = groups.isError || groups.isPaused;
  return (
    <SettingsPage
      title={t('access.groups.title')}
      description={t('access.groups.description')}
      action={
        <Button
          variant="primary"
          disabled={blocked}
          onClick={() => {
            setEditing('new');
          }}
        >
          {t('access.groups.create')}
        </Button>
      }
    >
      <SettingsCard title={t('access.groups.title')} description={t('access.groups.folderHint')}>
        <div className="p-4">
          <AccessSearch
            value={search}
            change={(value) => {
              setSearch(value);
              setSelected(null);
            }}
          />
        </div>
        <AccessListState
          pending={groups.isPending}
          failed={groups.isError}
          paused={groups.isPaused}
          empty={items.length === 0}
          retry={() => {
            void groups.refetch();
          }}
        >
          <ul>
            {items.map((group) => (
              <li
                key={group.id}
                className="flex items-start justify-between gap-4 border-t-hairline border-border-subtle px-6 py-4 max-narrow:flex-col max-narrow:px-4"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <h3 className="break-words text-heading text-ink">{group.name}</h3>
                  <p className="text-body text-ink-muted">
                    {t(group.kind === 'manual' ? 'access.manual' : 'access.directory')} ·{' '}
                    {t('access.groups.membersCount', { count: group.memberCount })}
                    {group.retiredAt !== null ? ` · ${t('access.retired')}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    aria-expanded={selected === group.id}
                    onClick={() => {
                      setSelected(selected === group.id ? null : group.id);
                    }}
                  >
                    {t('access.groups.open')}
                  </Button>
                  {group.kind === 'manual' && group.retiredAt === null && (
                    <>
                      <Button
                        disabled={blocked}
                        onClick={() => {
                          setEditing(group);
                        }}
                      >
                        {t('access.edit')}
                      </Button>
                      <Button
                        variant="dangerQuiet"
                        disabled={blocked}
                        onClick={() => {
                          task.clear();
                          setRetiring(group);
                        }}
                      >
                        {t('access.retire')}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <More
            more={groups.hasNextPage}
            busy={groups.isFetchingNextPage}
            load={() => {
              void groups.fetchNextPage();
            }}
          />
        </AccessListState>
      </SettingsCard>
      {chosen !== undefined && <GroupDetail key={chosen.id} group={chosen} stale={blocked} />}
      {editing !== null && (
        <GroupEditor
          group={editing === 'new' ? null : editing}
          close={() => {
            setEditing(null);
          }}
        />
      )}
      {retiring !== null && (
        <AccessConfirm
          title={t('access.groups.retireTitle', { name: retiring.name })}
          description={t('access.groups.retireHint')}
          confirm={t('access.retire')}
          busy={task.busy}
          problem={task.problem}
          close={() => {
            setRetiring(null);
          }}
          act={() => {
            task.run(
              () =>
                api.retireWorkspaceAccessGroup(workspaceId, retiring.id, {
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

const GroupEditor = ({
  group,
  close,
}: {
  readonly group: WorkspaceAccessGroup | null;
  readonly close: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { workspaceId } = useAccessScope();
  const task = useAccessTask();
  const [name, setName] = useState(group?.name ?? '');
  const [invalid, setInvalid] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !task.busy) close();
      }}
      title={t(group === null ? 'access.groups.create' : 'access.groups.edit')}
      description={t('access.groups.folderHint')}
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
              const input = { name: name.trim() };
              if (!Value.Check(CreateWorkspaceAccessGroupRequest, input)) {
                setInvalid(true);
                return;
              }
              task.run(
                () =>
                  group === null
                    ? api.createWorkspaceAccessGroup(workspaceId, input)
                    : api.updateWorkspaceAccessGroup(workspaceId, group.id, {
                        ...input,
                        revision: group.revision,
                      }),
                close,
              );
            }}
          >
            {t('access.save')}
          </Button>
        </>
      }
    >
      <TextField
        disabled={task.busy}
        label={t('access.name')}
        maxLength={64}
        value={name}
        onChange={(event) => {
          setName(event.currentTarget.value);
          setInvalid(false);
        }}
      />
      <AccessProblem text={invalid ? t('access.groups.invalid') : task.problem} />
    </Dialog>
  );
};

const GroupDetail = ({
  group,
  stale,
}: {
  readonly group: WorkspaceAccessGroup;
  readonly stale: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { workspaceId } = useAccessScope();
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<WorkspaceAccessGroupMember | null>(null);
  const task = useAccessTask();
  const members = useAccessList(['group-members', group.id, search], (query, signal) =>
    api.workspaceAccessGroupMembers(workspaceId, group.id, { ...query, q: search }, signal),
  );
  const items = members.data?.pages.flatMap((page) => page.data) ?? [];
  const editable = group.kind === 'manual' && group.retiredAt === null;
  const blocked = stale || members.isError || members.isPaused || group.retiredAt !== null;
  return (
    <>
      <SettingsCard
        title={group.name}
        description={t(
          group.kind === 'directory' ? 'access.groups.directoryHint' : 'access.groups.sourceHint',
        )}
        actions={
          editable ? (
            <Button
              disabled={blocked}
              onClick={() => {
                setAdding(true);
              }}
            >
              {t('access.groups.add')}
            </Button>
          ) : undefined
        }
      >
        <div className="p-4">
          <AccessSearch value={search} change={setSearch} label={t('access.people.search')} />
        </div>
        <AccessListState
          pending={members.isPending}
          failed={members.isError}
          paused={members.isPaused}
          empty={items.length === 0}
          retry={() => {
            void members.refetch();
          }}
        >
          <ul>
            {items.map((member) => (
              <li
                key={member.id}
                className="flex items-start gap-3 border-t-hairline border-border-subtle px-6 py-4 max-narrow:flex-wrap max-narrow:px-4"
              >
                <Avatar name={member.user.displayName} username={member.user.username} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-label text-ink">{member.user.displayName}</p>
                  <p className="break-words text-body text-ink-muted">
                    @{member.user.username} · {sourceName(member.source, t)} ·{' '}
                    {t(`access.source.${member.source.state}`)}
                  </p>
                </div>
                {editable && (
                  <Button
                    variant="dangerQuiet"
                    disabled={blocked}
                    onClick={() => {
                      task.clear();
                      setRemoving(member);
                    }}
                  >
                    {t('access.groups.remove')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <More
            more={members.hasNextPage}
            busy={members.isFetchingNextPage}
            load={() => {
              void members.fetchNextPage();
            }}
          />
        </AccessListState>
      </SettingsCard>
      <SettingsCard title={t('access.grants.title')}>
        <div className="px-6 py-5 max-narrow:px-4">
          <AccessGrants
            subject={{ kind: 'group', groupId: group.id }}
            revision={group.revision}
            disabled={blocked}
          />
        </div>
      </SettingsCard>
      {adding && (
        <GroupCandidates
          group={group}
          close={() => {
            setAdding(false);
          }}
        />
      )}
      {removing !== null && (
        <AccessConfirm
          title={t('access.groups.removeTitle', { name: removing.user.displayName })}
          description={t('access.groups.removeHint')}
          confirm={t('access.groups.remove')}
          busy={task.busy}
          problem={task.problem}
          close={() => {
            setRemoving(null);
          }}
          act={() => {
            task.run(
              () =>
                api.updateWorkspaceAccessGroupMembers(workspaceId, group.id, {
                  revision: group.revision,
                  removeSourceIds: [removing.sourceId],
                }),
              () => {
                setRemoving(null);
              },
            );
          }}
        />
      )}
    </>
  );
};

const GroupCandidates = ({
  group,
  close,
}: {
  readonly group: WorkspaceAccessGroup;
  readonly close: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { workspaceId } = useAccessScope();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<readonly string[]>([]);
  const task = useAccessTask();
  const candidates = useAccessList(['group-candidates', group.id, search], (query, signal) =>
    api.workspaceAccessGroupCandidates(workspaceId, group.id, { ...query, q: search }, signal),
  );
  const items = candidates.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <Dialog
      open
      size="wide"
      onOpenChange={(open) => {
        if (!open && !task.busy) close();
      }}
      title={t('access.groups.add')}
      description={t('access.groups.sourceHint')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button disabled={task.busy} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={task.busy}
            disabled={selected.length === 0 || candidates.isError || candidates.isPaused}
            onClick={() => {
              task.run(
                () =>
                  api.updateWorkspaceAccessGroupMembers(workspaceId, group.id, {
                    revision: group.revision,
                    addSourceIds: [...selected],
                  }),
                close,
              );
            }}
          >
            {t('access.groups.addSelected', { count: selected.length })}
          </Button>
        </>
      }
    >
      <AccessSearch
        value={search}
        change={(value) => {
          setSearch(value);
          setSelected([]);
        }}
        label={t('access.people.search')}
      />
      <AccessListState
        pending={candidates.isPending}
        failed={candidates.isError}
        paused={candidates.isPaused}
        empty={items.length === 0}
        retry={() => {
          void candidates.refetch();
        }}
      >
        <fieldset disabled={task.busy} className="flex min-w-0 flex-col gap-3">
          <legend className="mb-3 text-label text-ink">{t('access.groups.chooseSources')}</legend>
          {items.map((candidate) => (
            <label key={candidate.id} className="flex items-start gap-3">
              <Checkbox
                checked={selected.includes(candidate.id)}
                disabled={!selected.includes(candidate.id) && selected.length >= 100}
                onChange={(event) => {
                  setSelected(
                    event.currentTarget.checked
                      ? [...selected, candidate.id]
                      : selected.filter((id) => id !== candidate.id),
                  );
                }}
              />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="break-words text-label text-ink">
                  {candidate.user.displayName}
                </span>
                <span className="break-words text-body text-ink-muted">
                  @{candidate.user.username} · {sourceName(candidate.source, t)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <More
          more={candidates.hasNextPage}
          busy={candidates.isFetchingNextPage}
          load={() => {
            void candidates.fetchNextPage();
          }}
        />
      </AccessListState>
      <AccessProblem text={task.problem} />
    </Dialog>
  );
};
