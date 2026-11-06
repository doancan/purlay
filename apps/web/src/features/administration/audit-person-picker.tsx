import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ServerUsersQuery, type ServerUser } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { TextField } from '../../ui/text-field';
import { useAdministrationClient } from './context';
import { Empty, Pagination, QueryState, usePages } from './parts';

export const AuditPersonPicker = ({
  name,
  onChange,
}: {
  readonly name: string | null;
  readonly onChange: (user: ServerUser | null) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const choose = (user: ServerUser | null): void => {
    onChange(user);
    setOpen(false);
  };
  return (
    <>
      <Button
        className="w-full max-w-full justify-start"
        title={t('admin.audit.personChoice', { name: name ?? t('search.anyone') })}
        onClick={() => {
          setOpen(true);
        }}
      >
        <span className="truncate">
          {t('admin.audit.personChoice', { name: name ?? t('search.anyone') })}
        </span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('admin.audit.choosePerson')}
        description={t('admin.audit.choosePerson.body')}
        closeLabel={t('common.close')}
      >
        {open && <Directory choose={choose} />}
      </Dialog>
    </>
  );
};

const Directory = ({
  choose,
}: {
  readonly choose: (user: ServerUser | null) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [words, setWords] = useState('');
  const [filter, setFilter] = useState('');
  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setFilter(words.trim());
        }}
      >
        <div className="min-w-0 flex-1">
          <TextField
            label={t('admin.search')}
            value={words}
            maxLength={ServerUsersQuery.properties.q.maxLength}
            onChange={(event) => {
              setWords(event.target.value);
            }}
          />
        </div>
        <Button type="submit">{t('admin.find')}</Button>
      </form>
      <Button
        variant="ghost"
        onClick={() => {
          choose(null);
        }}
      >
        {t('search.anyone')}
      </Button>
      <People key={filter} filter={filter} choose={choose} />
    </div>
  );
};

const People = ({
  filter,
  choose,
}: {
  readonly filter: string;
  readonly choose: (user: ServerUser) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const client = useAdministrationClient();
  const pages = usePages();
  const query = useQuery({
    queryKey: ['server', 'audit-people', filter, pages.after],
    queryFn: async ({ signal }) =>
      await client.users(
        { q: filter, ...(pages.after === undefined ? {} : { after: pages.after }) },
        signal,
      ),
    retry: false,
  });
  return (
    <QueryState query={query}>
      {(data) => (
        <>
          {data.data.length === 0 ? (
            <Empty />
          ) : (
            <ul className="flex max-h-palette-list flex-col gap-2 overflow-y-auto">
              {data.data.map((user) => (
                <li key={user.id}>
                  <button
                    type="button"
                    className="flex w-full min-w-0 cursor-pointer items-start rounded-md px-3 py-3 text-left text-body text-ink hover:bg-surface-200"
                    aria-label={t('admin.audit.selectPerson', {
                      name: `${user.displayName} · ${user.email}`,
                    })}
                    onClick={() => {
                      choose(user);
                    }}
                  >
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="break-words">{user.displayName}</span>
                      <span className="text-caption text-ink-muted break-all">
                        @{user.username} · {user.email}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Pagination pages={pages} nextCursor={data.nextCursor} busy={query.isFetching} />
        </>
      )}
    </QueryState>
  );
};
