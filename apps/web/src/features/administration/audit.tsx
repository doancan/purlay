import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Value } from '@sinclair/typebox/value';
import { ServerAuditAction, ServerAuditQuery, type AuditExportFormat } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Select } from '../../ui/select';
import { TextField } from '../../ui/text-field';
import { SettingsCard } from '../settings/page';
import { useAdministrationClient } from './context';
import { Empty, Pagination, QueryState, usePages } from './parts';
import { AuditPersonPicker } from './audit-person-picker';

export const Audit = (): React.JSX.Element => {
  const { t } = useI18n();
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [actorName, setActorName] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filter, setFilter] = useState<ServerAuditQuery>({});
  const [invalid, setInvalid] = useState(false);
  const actionName = (name: string): string => {
    const known = ServerAuditAction.anyOf.find((item) => item.const === name);
    return known === undefined ? name : t(`admin.audit.action.${known.const}`);
  };
  const submit = (): void => {
    const start = from === '' ? undefined : new Date(from);
    const end = to === '' ? undefined : new Date(to);
    if (
      (start !== undefined && !Number.isFinite(start.getTime())) ||
      (end !== undefined && !Number.isFinite(end.getTime()))
    ) {
      setInvalid(true);
      return;
    }
    const query: unknown = {
      ...(action === '' ? {} : { action }),
      ...(actor.trim() === '' ? {} : { actorUserId: actor.trim() }),
      ...(start === undefined ? {} : { from: start.toISOString() }),
      ...(end === undefined ? {} : { to: end.toISOString() }),
    };
    if (
      !Value.Check(ServerAuditQuery, query) ||
      (start !== undefined && end !== undefined && start > end)
    ) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setFilter(query);
  };
  return (
    <>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="flex min-w-0 flex-col gap-1 text-label text-ink max-narrow:w-full">
          {t('admin.action')}
          <Select
            value={action}
            onChange={(event) => {
              setAction(event.target.value);
            }}
          >
            <option value="">{t('admin.all')}</option>
            {ServerAuditAction.anyOf.map((item) => (
              <option key={item.const} value={item.const}>
                {actionName(item.const)}
              </option>
            ))}
          </Select>
        </label>
        <div className="min-w-0 flex-1 max-narrow:w-full max-narrow:flex-auto">
          <AuditPersonPicker
            name={actorName}
            onChange={(user) => {
              setActor(user?.id ?? '');
              setActorName(user?.displayName ?? null);
            }}
          />
        </div>
        <TextField
          label={t('admin.from')}
          type="datetime-local"
          value={from}
          onChange={(event) => {
            setFrom(event.target.value);
          }}
        />
        <TextField
          label={t('admin.to')}
          type="datetime-local"
          value={to}
          onChange={(event) => {
            setTo(event.target.value);
          }}
        />
        <Button type="submit">{t('admin.find')}</Button>
      </form>
      {invalid && (
        <p role="alert" className="text-body text-danger-text">
          {t('admin.dateError')}
        </p>
      )}
      <AuditList
        key={JSON.stringify(filter)}
        filter={filter}
        actionName={actionName}
        chooseActor={(id, name) => {
          setActor(id);
          setActorName(name);
        }}
      />
    </>
  );
};
const AuditList = ({
  filter,
  actionName,
  chooseActor,
}: {
  readonly filter: ServerAuditQuery;
  readonly actionName: (action: string) => string;
  readonly chooseActor: (id: string, name: string) => void;
}): React.JSX.Element => {
  const client = useAdministrationClient();
  const { t, format } = useI18n();
  const pages = usePages();
  const download = (format: AuditExportFormat): string => {
    const params = new URLSearchParams({ format });
    for (const [key, value] of Object.entries(filter))
      if (key !== 'after' && key !== 'limit') params.set(key, String(value));
    return `/api/server/audit/export?${params.toString()}`;
  };
  const query = useQuery({
    queryKey: ['server', 'audit', filter, pages.after],
    queryFn: async ({ signal }) =>
      await client.audit(
        { ...filter, ...(pages.after === undefined ? {} : { after: pages.after }) },
        signal,
      ),
    retry: false,
  });
  return (
    <QueryState query={query}>
      {(data) => (
        <>
          <SettingsCard title={t('admin.audit')}>
            <div className="flex flex-wrap items-center gap-3 px-6 py-4 max-narrow:px-4">
              <span className="text-body text-ink-muted">{t('admin.audit.download')}</span>
              <a className="text-label text-accent-text underline" href={download('csv')}>
                {t('admin.audit.csv')}
              </a>
              <a className="text-label text-accent-text underline" href={download('ndjson')}>
                {t('admin.audit.ndjson')}
              </a>
            </div>
            {data.data.length === 0 ? (
              <Empty />
            ) : (
              <ol>
                {data.data.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex flex-col gap-1 not-last:border-b-hairline border-border-subtle px-6 py-4 max-narrow:px-4"
                  >
                    <p className="text-label text-ink break-words">{actionName(entry.action)}</p>
                    {entry.actorUserId === null ? (
                      <p className="text-body text-ink-muted">
                        {entry.actorName ?? t('admin.system')}
                      </p>
                    ) : (
                      <button
                        type="button"
                        className="w-fit max-w-full cursor-pointer py-1 text-left text-body text-accent-text break-words underline"
                        onClick={() => {
                          if (entry.actorUserId !== null)
                            chooseActor(entry.actorUserId, entry.actorName ?? t('admin.system'));
                        }}
                      >
                        {entry.actorName ?? t('admin.system')}
                      </button>
                    )}
                    <time className="text-caption text-ink-muted" dateTime={entry.createdAt}>
                      {format.absolute(entry.createdAt)}
                    </time>
                    <details className="text-caption text-ink-muted">
                      <summary className="cursor-pointer">{t('admin.audit.details')}</summary>
                      <p className="font-mono break-all">{entry.actorUserId}</p>
                      {(entry.targetUserId ?? entry.targetWorkspaceId) !== null && (
                        <p className="text-caption text-ink-muted break-all">
                          {t('admin.target')}: {entry.targetUserId ?? entry.targetWorkspaceId}
                        </p>
                      )}
                      {entry.targetModule !== null && (
                        <p className="font-mono text-caption text-ink-muted">
                          {entry.targetModule}
                        </p>
                      )}
                    </details>
                  </li>
                ))}
              </ol>
            )}
          </SettingsCard>
          <Pagination pages={pages} nextCursor={data.nextCursor} busy={query.isFetching} />
        </>
      )}
    </QueryState>
  );
};
