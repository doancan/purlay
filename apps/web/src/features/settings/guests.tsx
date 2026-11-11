/** Bounded guest administration lives beside full memberships, with deliberate scope and expiry changes. */
import { useEffect, useId, useRef, useState } from 'react';
import {
  GUEST_CHANNELS_MAX,
  GUEST_SEARCH_MAX,
  PAGE_LIMIT,
  type WorkspaceGuest,
  type UpdateGuestAccessRequest,
} from '@purlay/types';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { systemClock } from '../../system-clock';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { DateField } from '../../ui/date-field';
import { Select } from '../../ui/select';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { TextField, FINDABLE_FROM } from '../../ui/text-field';
import { useWorkspace } from '../shell/workspace';
import { SettingsCard } from './page';
import { useGuestDirectory } from './guest-directory';
import { guestExpiryFields, guestExpiryInstant } from './guest-expiry';
import { GuestInvitationForm } from './guest-invitation';

const scopeKey = (guest: WorkspaceGuest): string =>
  JSON.stringify([
    guest.joinedAt,
    guest.access.historySince,
    guest.access.expiresAt,
    [...guest.channelIds].sort(),
    guest.hiddenChannelCount,
  ]);

const GuestAccessForm = ({
  base,
  current,
  busy,
  blocked,
  onSave,
  onCancel,
  onReload,
}: {
  readonly base: WorkspaceGuest;
  readonly current: WorkspaceGuest;
  readonly busy: boolean;
  readonly blocked: boolean;
  readonly onSave: (input: UpdateGuestAccessRequest) => void;
  readonly onCancel: () => void;
  readonly onReload: () => void;
}): React.JSX.Element => {
  const { t, locale } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const [selected, setSelected] = useState(() => new Set(base.channelIds));
  const [expiry, setExpiry] = useState<'keep' | 'never' | 'date'>('keep');
  const initial =
    base.access.expiresAt !== null && new Date(base.access.expiresAt) > systemClock.now()
      ? guestExpiryFields(base.access.expiresAt)
      : { day: '', time: '' };
  const [day, setDay] = useState(initial.day);
  const [time, setTime] = useState(initial.time);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState<number>(PAGE_LIMIT.default);
  const [problem, setProblem] = useState<string | null>(null);
  const stale = scopeKey(base) !== scopeKey(current);
  const changedChannels =
    JSON.stringify([...selected].sort()) !== JSON.stringify([...base.channelIds].sort());
  const choices = (channels.data ?? []).filter((channel) => channel.type !== 'direct_message');
  const wanted = query.trim().toLocaleLowerCase(locale);
  const filtered = choices.filter((channel) =>
    (channel.name ?? '').toLocaleLowerCase(locale).includes(wanted),
  );
  useEffect(() => {
    form.current?.querySelector<HTMLSelectElement>('select')?.focus();
  }, []);
  return (
    <form
      ref={form}
      className="flex flex-col gap-5 border-t-hairline border-border-subtle bg-surface-050 px-6 py-5 max-narrow:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || blocked || stale) return;
        const at = expiry === 'date' ? guestExpiryInstant(day, time) : null;
        if (expiry === 'date' && (at === null || new Date(at) <= systemClock.now())) {
          setProblem(t('guests.futureExpiry'));
          return;
        }
        if (selected.size + base.hiddenChannelCount > GUEST_CHANNELS_MAX) {
          setProblem(t('guests.limit', { count: GUEST_CHANNELS_MAX }));
          return;
        }
        if (changedChannels && (channels.data === undefined || channels.isError)) {
          setProblem(t('guests.channelsFailed'));
          return;
        }
        setProblem(null);
        onSave({
          ...(changedChannels ? { channelIds: [...selected] } : {}),
          ...(expiry === 'keep' ? {} : { accessExpiresAt: expiry === 'never' ? null : at }),
        });
      }}
    >
      {stale && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-label text-warning-text"
        >
          <p>{t('guests.changed')}</p>
          <Button disabled={busy} onClick={onReload}>
            {t('guests.reload')}
          </Button>
        </div>
      )}
      <fieldset disabled={busy || blocked || stale} className="flex min-w-0 flex-col gap-5">
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-expiry`} className="text-label text-ink">
            {t('guests.expiry')}
          </label>
          <Select
            id={`${id}-expiry`}
            value={expiry}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'keep' || value === 'never' || value === 'date') {
                setExpiry(value);
                setProblem(null);
              }
            }}
          >
            <option value="keep">{t('guests.keepExpiry')}</option>
            <option value="never">{t('guests.noEnd')}</option>
            <option value="date">{t('guests.chooseEnd')}</option>
          </Select>
          <p className="text-caption text-ink-muted">{t('guests.reactivation')}</p>
        </div>
        {expiry === 'date' && (
          <div className="grid gap-4 narrow:grid-cols-2">
            <DateField
              label={t('guests.endDay')}
              value={day}
              onChange={(value) => {
                setDay(value);
                setProblem(null);
              }}
            />
            <TextField
              type="time"
              label={t('guests.endTime')}
              value={time}
              onChange={(event) => {
                setTime(event.target.value);
                setProblem(null);
              }}
              hint={t('guests.timezone', {
                zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              })}
            />
          </div>
        )}
        <fieldset className="flex min-w-0 flex-col gap-3" aria-describedby={`${id}-scope-help`}>
          <legend className="text-label text-ink">{t('guests.channels')}</legend>
          <p id={`${id}-scope-help`} className="text-caption text-ink-muted">
            {t('guests.limit', { count: GUEST_CHANNELS_MAX })} {t('guests.preserveHidden')}
          </p>
          {channels.isError && (
            <div role="alert" className="flex flex-wrap gap-3 text-label text-danger-text">
              <p>{t('guests.channelsFailed')}</p>
              <Button
                busy={channels.isFetching}
                onClick={() => {
                  void channels.refetch();
                }}
              >
                {t('common.retry')}
              </Button>
            </div>
          )}
          {channels.data === undefined ? (
            !channels.isError && (
              <LoadingStatus label={t('common.loading')}>
                <Skeleton />
              </LoadingStatus>
            )
          ) : (
            <>
              {choices.length >= FINDABLE_FROM && (
                <TextField
                  label={t('guests.findChannel')}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setShown(PAGE_LIMIT.default);
                  }}
                />
              )}
              <div className="grid gap-2 narrow:grid-cols-2">
                {filtered.slice(0, shown).map((channel) => (
                  <label
                    key={channel.id}
                    className="flex min-w-0 items-start gap-3 rounded-md px-2 py-2 text-label text-ink hover:bg-surface-200"
                  >
                    <Checkbox
                      checked={selected.has(channel.id)}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setSelected((before) => {
                          const next = new Set(before);
                          if (checked) next.add(channel.id);
                          else next.delete(channel.id);
                          return next;
                        });
                        setProblem(null);
                      }}
                    />
                    <span className="min-w-0 break-words">#{channel.name ?? channel.id}</span>
                  </label>
                ))}
              </div>
              {filtered.length === 0 && (
                <p className="text-label text-ink-muted">{t('guests.noChannelMatch')}</p>
              )}
              {filtered.length > shown && (
                <Button
                  onClick={() => {
                    setShown((before) => before + PAGE_LIMIT.default);
                  }}
                >
                  {t('guests.moreChannels')}
                </Button>
              )}
            </>
          )}
        </fieldset>
      </fieldset>
      {selected.size === 0 && (
        <p className="text-caption text-ink-muted">{t('guests.noSelection')}</p>
      )}
      {problem !== null && (
        <p role="alert" className="text-label text-danger-text">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-3">
        <Button disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          disabled={blocked || stale || (!changedChannels && expiry === 'keep')}
        >
          {t('guests.save')}
        </Button>
      </div>
    </form>
  );
};

const GuestRow = ({
  guest,
  blocked,
  directory,
  recoverFocus,
}: {
  readonly guest: WorkspaceGuest;
  readonly blocked: boolean;
  readonly directory: ReturnType<typeof useGuestDirectory>;
  readonly recoverFocus: () => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const [editing, setEditing] = useState<
    | { readonly kind: 'scope'; readonly base: WorkspaceGuest }
    | { readonly kind: 'remove' }
    | { readonly kind: 'convert' }
    | null
  >(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const removing = useRef<HTMLButtonElement>(null);
  const converting = useRef<HTMLButtonElement>(null);
  const cancelRemoval = useRef<HTMLButtonElement>(null);
  const restore = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  useEffect(() => {
    alive.current = true;
    return (): void => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (editing?.kind === 'remove' || editing?.kind === 'convert') {
      cancelRemoval.current?.focus();
      return;
    }
    if (editing !== null || restore.current === null) return;
    const button = restore.current;
    restore.current = null;
    if (button.disabled) recoverFocus();
    else button.focus();
  }, [editing, recoverFocus]);
  const run = async (input: UpdateGuestAccessRequest | null | 'convert'): Promise<void> => {
    if (pending.current || blocked) return;
    pending.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const outcome =
        input === 'convert'
          ? await directory.convert(guest.user.id)
          : input === null
            ? await directory.remove(guest.user.id)
            : await directory.edit(guest.user.id, input);
      if (!alive.current) return;
      if (outcome.ok) setEditing(null);
      else setProblem(outcome.problem);
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const expired =
    guest.access.expiresAt !== null && new Date(guest.access.expiresAt) <= systemClock.now();
  return (
    <li className="flex min-w-0 flex-col not-first:border-t-hairline border-border-subtle">
      <div className="flex min-w-0 items-start gap-4 px-6 py-4 max-narrow:flex-wrap max-narrow:px-4">
        <Avatar name={guest.user.displayName} username={guest.user.username} size="md" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="break-words text-label text-ink">{guest.user.displayName}</span>
          <span className="break-all font-mono text-caption text-ink-muted">
            @{guest.user.username}
          </span>
          <span className="text-caption text-ink-muted">
            {guest.access.expiresAt === null
              ? t('guests.noEnd')
              : t(expired ? 'guests.expired' : 'guests.ends', {
                  at: format.absolute(guest.access.expiresAt),
                })}
          </span>
          <span className="text-caption text-ink-muted">
            {t('guests.history', { at: format.absolute(guest.access.historySince) })}
          </span>
          <span className="break-words text-caption text-ink-muted">
            {guest.channelIds.length === 0
              ? t('guests.noVisible')
              : guest.channelIds
                  .map(
                    (channelId) =>
                      `#${channels.data?.find((channel) => channel.id === channelId)?.name ?? t('guests.unavailable')}`,
                  )
                  .join(', ')}
          </span>
          {guest.hiddenChannelCount > 0 && (
            <span className="text-caption text-ink-muted">
              {t(guest.hiddenChannelCount === 1 ? 'guests.hidden.one' : 'guests.hidden.other', {
                count: guest.hiddenChannelCount,
              })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2 max-narrow:w-full max-narrow:justify-end">
          <Button
            ref={trigger}
            aria-label={t('guests.manageFor', { name: guest.user.displayName })}
            aria-expanded={editing?.kind === 'scope'}
            aria-controls={id}
            disabled={blocked || editing !== null}
            onClick={() => {
              restore.current = trigger.current;
              setProblem(null);
              setEditing({ kind: 'scope', base: guest });
            }}
          >
            {t('guests.manage')}
          </Button>
          <Button
            ref={converting}
            aria-label={t('guests.convertFor', { name: guest.user.displayName })}
            disabled={blocked || editing !== null}
            onClick={() => {
              restore.current = converting.current;
              setAcknowledged(false);
              setProblem(null);
              setEditing({ kind: 'convert' });
            }}
          >
            {t('guests.convert')}
          </Button>
          <Button
            ref={removing}
            variant="dangerQuiet"
            aria-label={t('guests.removeFor', { name: guest.user.displayName })}
            disabled={blocked || editing !== null}
            onClick={() => {
              restore.current = removing.current;
              setProblem(null);
              setEditing({ kind: 'remove' });
            }}
          >
            {t('guests.remove')}
          </Button>
        </div>
      </div>
      <div id={id}>
        {editing?.kind === 'scope' && (
          <GuestAccessForm
            key={scopeKey(editing.base)}
            base={editing.base}
            current={guest}
            busy={busy}
            blocked={blocked}
            onSave={(input) => {
              void run(input);
            }}
            onCancel={() => {
              setProblem(null);
              setEditing(null);
            }}
            onReload={() => {
              setProblem(null);
              setEditing({ kind: 'scope', base: guest });
            }}
          />
        )}
        {editing?.kind === 'convert' && (
          <div className="flex flex-col gap-4 border-t-hairline border-border-subtle bg-surface-050 px-6 py-4 max-narrow:px-4">
            <p className="text-label text-ink">
              {t('guests.convertAsk', { name: guest.user.displayName })}
            </p>
            <p className="text-caption text-ink-muted">{t('guests.convertScope')}</p>
            <label className="flex items-start gap-3 text-label text-ink">
              <Checkbox
                checked={acknowledged}
                disabled={busy || blocked}
                onChange={(event) => {
                  setAcknowledged(event.target.checked);
                }}
              />
              {t('guests.convertAcknowledge')}
            </label>
            <div className="flex flex-wrap justify-end gap-3">
              <Button
                ref={cancelRemoval}
                disabled={busy}
                onClick={() => {
                  setProblem(null);
                  setEditing(null);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                busy={busy}
                disabled={blocked || !acknowledged}
                onClick={() => {
                  if (acknowledged) void run('convert');
                }}
              >
                {t('guests.convertConfirm')}
              </Button>
            </div>
          </div>
        )}
        {editing?.kind === 'remove' && (
          <div className="flex flex-wrap items-center gap-3 border-t-hairline border-border-subtle bg-danger-subtle px-6 py-4 max-narrow:px-4">
            <p className="min-w-0 flex-1 text-label text-danger-text">
              {t('guests.removeAsk', { name: guest.user.displayName })}
            </p>
            <Button
              ref={cancelRemoval}
              disabled={busy}
              onClick={() => {
                setProblem(null);
                setEditing(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              busy={busy}
              disabled={blocked}
              onClick={() => {
                void run(null);
              }}
            >
              {t('guests.removeConfirm')}
            </Button>
          </div>
        )}
        {problem !== null && (
          <p role="alert" className="px-6 py-3 text-label text-danger-text max-narrow:px-4">
            {problem}
          </p>
        )}
      </div>
    </li>
  );
};

export const GuestAdministration = (): React.JSX.Element => {
  const { t } = useI18n();
  const search = useRef<HTMLInputElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const directory = useGuestDirectory(() => {
    search.current?.focus();
  });
  const { list } = directory;
  const [query, setQuery] = useState('');
  const seen = new Set<string>();
  const rows =
    list.data?.pages
      .flatMap((page) => page.data)
      .filter((row) => {
        if (seen.has(row.user.id)) return false;
        seen.add(row.user.id);
        return true;
      }) ?? [];
  return (
    <>
      <GuestInvitationForm />
      <SettingsCard title={t('guests.title')} description={t('guests.description')}>
        <form
          className="flex flex-wrap items-end gap-3 border-b-hairline border-border-subtle px-6 py-4 max-narrow:px-4"
          onSubmit={(event) => {
            event.preventDefault();
            directory.search(query);
          }}
        >
          <div className="min-w-0 flex-1">
            <TextField
              ref={search}
              label={t('guests.search')}
              maxLength={GUEST_SEARCH_MAX}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </div>
          <Button type="submit">{t('guests.searchAction')}</Button>
        </form>
        {directory.notice !== null && (
          <p role="status" className="px-6 py-3 text-label text-ink-muted max-narrow:px-4">
            {directory.notice}
          </p>
        )}
        {list.isError && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 px-6 py-4 text-label text-danger-text max-narrow:px-4"
          >
            <p>{t('guests.loadFailed')}</p>
            <Button
              ref={retry}
              busy={list.isFetching}
              onClick={() => {
                void directory.retry();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        )}
        {list.data === undefined ? (
          !list.isError && (
            <LoadingStatus label={t('common.loading')} className="px-6 py-4">
              <Skeleton />
              <Skeleton />
            </LoadingStatus>
          )
        ) : rows.length === 0 ? (
          <p className="px-6 py-5 text-label text-ink-muted max-narrow:px-4">{t('guests.none')}</p>
        ) : (
          <ul aria-label={t('guests.title')} className="flex min-w-0 flex-col">
            {rows.map((guest) => (
              <GuestRow
                key={guest.user.id}
                guest={guest}
                blocked={list.isError || list.isFetching}
                directory={directory}
                recoverFocus={() => {
                  (retry.current ?? search.current)?.focus();
                }}
              />
            ))}
          </ul>
        )}
        {list.hasNextPage && (
          <div className="flex justify-end px-6 py-4 max-narrow:px-4">
            <Button
              busy={list.isFetchingNextPage}
              disabled={list.isFetching}
              onClick={() => {
                void list.fetchNextPage();
              }}
            >
              {t('guests.older')}
            </Button>
          </div>
        )}
      </SettingsCard>
    </>
  );
};
