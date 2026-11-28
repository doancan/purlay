import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ServerUsersQuery, type ServerUser } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { Icon } from '../../components/icon';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { Dialog } from '../../ui/dialog';
import { TextField } from '../../ui/text-field';
import { useAdministrationClient } from './context';
import { Empty, Pagination, QueryState, usePages } from './parts';
import { keys } from '../../data/keys';

/** A choice in the chooser. Its list is drawn out by the row's padding, so the text sits on the field's edge and the hover wash in the dialog's gutter. */
const personRowClasses =
  'flex min-w-0 cursor-pointer items-start rounded-md px-3 py-2 text-left text-body text-ink transition-colors duration-hover ease-standard hover:bg-surface-200';

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
      {/* Labelled above and drawn as the action's select beside it, so the filters read as one row of fields. */}
      <div className="flex min-w-0 flex-col gap-1">
        <span aria-hidden="true" className="text-label text-ink">
          {t('admin.audit.person')}
        </span>
        <button
          type="button"
          aria-label={t('admin.audit.personChoice', { name: name ?? t('search.anyone') })}
          className="relative flex h-control w-full min-w-0 cursor-pointer items-center rounded-md border-hairline border-border-strong bg-surface-100 pr-8 pl-3 text-left text-label text-ink transition-colors duration-hover ease-standard hover:bg-surface-050 max-narrow:h-touch max-narrow:text-title max-narrow:font-normal"
          onClick={() => {
            setOpen(true);
          }}
        >
          <span className="truncate">{name ?? t('search.anyone')}</span>
          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-ink-muted">
            <Icon name="collapse" size="sm" />
          </span>
        </button>
      </div>
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
      {/* Anyone is one more choice in the list, drawn as the people are, not a button of its own in the middle. */}
      <button
        type="button"
        className={cn(personRowClasses, '-mx-3 -mb-3')}
        onClick={() => {
          choose(null);
        }}
      >
        {t('search.anyone')}
      </button>
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
    queryKey: keys.serverAuditPeople(filter, pages.after),
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
            <ul className="-mx-3 flex max-h-palette-list flex-col gap-1 overflow-y-auto">
              {data.data.map((user) => (
                <li key={user.id}>
                  <button
                    type="button"
                    className={cn(personRowClasses, 'w-full')}
                    aria-label={t('admin.audit.selectPerson', {
                      name: `${user.displayName} · ${user.email}`,
                    })}
                    onClick={() => {
                      choose(user);
                    }}
                  >
                    <span className="flex min-w-0 flex-col">
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
