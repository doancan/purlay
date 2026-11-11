/** A named, bounded guest invitation; the one-time link stays only in this account's mounted form. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import {
  EMAIL_MAX,
  GUEST_CHANNELS_MAX,
  INVITATION_TTL_DAYS,
  PAGE_LIMIT,
  normalisedMailbox,
  type CreatedGuestInvitation,
  type MeResponse,
} from '@purlay/types';
import { useApi } from '../../data/api-provider';
import { captureAccess, useAccessRevision } from '../../data/access-revision';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { systemClock } from '../../system-clock';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { DateField } from '../../ui/date-field';
import { Select } from '../../ui/select';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { TextField, FINDABLE_FROM } from '../../ui/text-field';
import { useToast } from '../../ui/toast';
import { useContentPorts } from '../content/content-ports';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';
import { InvitationMailOutcome } from '../invitations/invitation-form';
import { guestExpiryFields, guestExpiryInstant } from './guest-expiry';
import { MadeLink } from './invitations';
import { SettingsCard } from './page';

const defaultEnd = (): { readonly day: string; readonly time: string } => {
  const end = new Date(systemClock.now());
  end.setDate(end.getDate() + INVITATION_TTL_DAYS);
  return guestExpiryFields(end.toISOString());
};

const GuestInvitationControls = ({
  isCurrent,
  userId,
}: {
  readonly isCurrent: () => boolean;
  readonly userId: string;
}): React.JSX.Element => {
  const api = useApi();
  const client = useQueryClient();
  const { workspace } = useWorkspace();
  const { t, locale } = useI18n();
  const describe = useDescribeFailure();
  const { copy } = useContentPorts();
  const { show } = useToast();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [email, setEmail] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState<number>(PAGE_LIMIT.default);
  const [end, setEnd] = useState(defaultEnd);
  const [expiry, setExpiry] = useState<'date' | 'never'>('date');
  const [problem, setProblem] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState<CreatedGuestInvitation | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  const owns = (): boolean =>
    alive.current && isCurrent() && client.getQueryData<MeResponse>(keys.me)?.user.id === userId;
  useEffect(() => {
    alive.current = true;
    return (): void => {
      alive.current = false;
    };
  }, []);
  const availability = useQuery({
    queryKey: keys.guestInvitationAvailability(workspace.id),
    queryFn: ({ signal }) => api.guestInvitationAvailability(workspace.id, signal),
  });
  const ready = availability.data?.enabled === true && !availability.isError;
  const channels = useChannels(workspace.id, ready && expanded && made === null);
  const choices = (channels.data ?? []).filter((channel) => channel.type !== 'direct_message');
  const filtered = choices.filter((channel) =>
    (channel.name ?? '').toLocaleLowerCase(locale).includes(query.toLocaleLowerCase(locale)),
  );
  const refresh = async (): Promise<void> => {
    try {
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.guests(workspace.id) }, { throwOnError: true }),
        client.invalidateQueries(
          { queryKey: keys.invitations(workspace.id) },
          { throwOnError: true },
        ),
        client.invalidateQueries(
          { queryKey: keys.invitationRecipients(workspace.id) },
          { throwOnError: true },
        ),
      ]);
      if (owns()) setRefreshFailed(false);
    } catch {
      if (owns()) setRefreshFailed(true);
    }
  };
  const submit = async (): Promise<void> => {
    if (busy.current || !ready || !owns()) return;
    const address = normalisedMailbox(email);
    if (address === undefined) {
      setProblem(t('guestInvite.invalidEmail'));
      return;
    }
    if (selected.size === 0 || selected.size > GUEST_CHANNELS_MAX) {
      setProblem(t('guestInvite.chooseChannels', { count: GUEST_CHANNELS_MAX }));
      return;
    }
    if (
      channels.isError ||
      channels.data === undefined ||
      [...selected].some((value) => !choices.some((choice) => choice.id === value))
    ) {
      setProblem(t('guests.channelsFailed'));
      return;
    }
    const until = expiry === 'never' ? null : guestExpiryInstant(end.day, end.time);
    if (expiry === 'date' && (until === null || new Date(until) <= systemClock.now())) {
      setProblem(t('guests.futureExpiry'));
      return;
    }
    busy.current = true;
    setMaking(true);
    setProblem(null);
    try {
      const created = await api.createGuestInvitation(workspace.id, {
        email: address,
        channelIds: [...selected],
        accessExpiresAt: until,
        locale,
      });
      if (!owns()) return;
      setMade(created);
      setExpanded(false);
      await refresh();
    } catch (failure) {
      if (owns()) setProblem(`${t('guestInvite.unconfirmed')} ${describe(failure)}`);
    } finally {
      busy.current = false;
      if (owns()) setMaking(false);
    }
  };
  const copyLink = (link: string): void => {
    if (!owns()) return;
    copy(link).then(
      () => {
        if (owns()) show({ message: t('common.copied') });
      },
      () => {
        if (owns()) show({ message: t('failure.copy') });
      },
    );
  };
  return (
    <SettingsCard title={t('guestInvite.title')} description={t('guestInvite.description')}>
      <div className="flex min-w-0 flex-col gap-4 px-6 py-5 max-narrow:px-4">
        {availability.isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 text-label text-danger-text"
          >
            <p>{t('guestInvite.checkFailed')}</p>
            <Button
              busy={availability.isFetching}
              onClick={() => {
                void availability.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : availability.data === undefined ? (
          <LoadingStatus label={t('common.loading')}>
            <Skeleton />
          </LoadingStatus>
        ) : !ready ? (
          <p className="text-label text-ink-muted">{t('guestInvite.notReady')}</p>
        ) : null}
        {made !== null ? (
          <div className="flex min-w-0 flex-col gap-3">
            <p role="status" className="text-label text-ink">
              {t('guestInvite.created')}
            </p>
            <p className="break-words text-label text-ink-muted">
              {t('guestInvite.namedLink', { email: made.guest.email })}
            </p>
            <MadeLink link={`${window.location.origin}/invite#${made.token}`} onCopy={copyLink} />
            {made.mail !== undefined && <InvitationMailOutcome results={made.mail} />}
            {refreshFailed && (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-3 text-label text-danger-text"
              >
                <p>{t('guestInvite.refreshFailed')}</p>
                <Button
                  busy={making}
                  onClick={() => {
                    void refresh();
                  }}
                >
                  {t('common.retry')}
                </Button>
              </div>
            )}
            <div>
              <Button
                disabled={making || !ready}
                onClick={() => {
                  setMade(null);
                  setEmail('');
                  setSelected(new Set());
                  setProblem(null);
                  setRefreshFailed(false);
                  setExpanded(true);
                }}
              >
                {t('guestInvite.another')}
              </Button>
            </div>
          </div>
        ) : !expanded ? (
          <div>
            <Button
              variant="primary"
              disabled={!ready}
              onClick={() => {
                setExpanded(true);
              }}
            >
              {t('guestInvite.open')}
            </Button>
          </div>
        ) : (
          <form
            noValidate
            className="flex min-w-0 flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <fieldset disabled={making || !ready} className="flex min-w-0 flex-col gap-4">
              <TextField
                label={t('guestInvite.email')}
                type="email"
                autoComplete="off"
                maxLength={EMAIL_MAX}
                value={email}
                autoFocus
                onChange={(event) => {
                  setEmail(event.target.value);
                  setProblem(null);
                }}
                hint={t('guestInvite.emailHint')}
              />
              <fieldset className="flex min-w-0 flex-col gap-3">
                <legend className="text-label text-ink">{t('guests.channels')}</legend>
                <p className="text-caption text-ink-muted">
                  {t('guestInvite.chooseChannels', { count: GUEST_CHANNELS_MAX })}
                </p>
                {channels.isError ? (
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
                ) : channels.data === undefined ? (
                  <LoadingStatus label={t('common.loading')}>
                    <Skeleton />
                  </LoadingStatus>
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
                            disabled={
                              !selected.has(channel.id) && selected.size >= GUEST_CHANNELS_MAX
                            }
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
              <div className="flex flex-col gap-2">
                <label htmlFor={`${id}-end`} className="text-label text-ink">
                  {t('guests.expiry')}
                </label>
                <Select
                  id={`${id}-end`}
                  value={expiry}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === 'date' || value === 'never') {
                      setExpiry(value);
                      setProblem(null);
                    }
                  }}
                >
                  <option value="date">{t('guests.chooseEnd')}</option>
                  <option value="never">{t('guests.noEnd')}</option>
                </Select>
              </div>
              {expiry === 'date' && (
                <div className="grid gap-4 narrow:grid-cols-2">
                  <DateField
                    label={t('guests.endDay')}
                    value={end.day}
                    onChange={(day) => {
                      setEnd((before) => ({ ...before, day }));
                      setProblem(null);
                    }}
                  />
                  <TextField
                    type="time"
                    label={t('guests.endTime')}
                    value={end.time}
                    onChange={(event) => {
                      const time = event.target.value;
                      setEnd((before) => ({ ...before, time }));
                      setProblem(null);
                    }}
                    hint={t('guests.timezone', {
                      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    })}
                  />
                </div>
              )}
              <p className="text-caption text-ink-muted">
                {t(
                  availability.data?.email === true ? 'guestInvite.mailOn' : 'guestInvite.mailOff',
                )}
              </p>
            </fieldset>
            {problem !== null && (
              <p role="alert" className="text-label text-danger-text">
                {problem}
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                variant="primary"
                busy={making}
                disabled={!ready || channels.data === undefined || channels.isError}
              >
                {t('guestInvite.submit')}
              </Button>
              <Button
                disabled={making}
                onClick={() => {
                  setExpanded(false);
                  setProblem(null);
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </SettingsCard>
  );
};

export const GuestInvitationForm = (): React.JSX.Element => {
  const client = useQueryClient();
  const { user } = useSession();
  const { workspace } = useWorkspace();
  useAccessRevision(client);
  const owner = useRef<{ readonly isCurrent: () => boolean; readonly generation: number } | null>(
    null,
  );
  if (!owner.current?.isCurrent())
    owner.current = {
      isCurrent: captureAccess(client, keys.me),
      generation: (owner.current?.generation ?? 0) + 1,
    };
  return (
    <GuestInvitationControls
      key={`${workspace.id}:${user.id}:${String(owner.current.generation)}`}
      isCurrent={owner.current.isCurrent}
      userId={user.id}
    />
  );
};
