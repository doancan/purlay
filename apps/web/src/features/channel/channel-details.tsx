/**
 * A channel's details (D-123), opened from its name in the header: the product's wide dialog with
 * tabs (D-154). **About** — its name and topic, what the person is told about said in words, and at
 * the foot a danger zone with Leave and (for an owner or an admin) Archive; **Members** — who is in
 * it, found by name when there are many, with Add people and — for whoever may (D-172) — Remove; **Integrations** — the repositories it
 * hears from, an owner's or an admin's only (D-134), and absent for anybody else. Files and pins are
 * not here (#485).
 *
 * What is offered is what the server would allow: only a member edits the name and topic, only a
 * member leaves, only an owner or an admin archives. The server stays the authority, and what it
 * refuses is said in words — a taken name under the name field, the last member of a private channel
 * in a sentence that says what to do instead. Leaving and archiving cost something, so each asks
 * first, in place, as removing a member does.
 */
import { useQueryClient } from '@tanstack/react-query';
import {
  CHANNEL_NAME_MAX,
  type Channel,
  type ChannelMember,
  type UpdateChannelRequest,
  type UserRole,
} from '@purlay/types';
import { useEffect, useId, useRef, useState } from 'react';
import { fold } from '../composer/mention-suggest';
import { useActions } from '../../data/actions-provider';
import { useApi } from '../../data/api-provider';
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useChannelMembers, useMembers } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { Dialog } from '../../ui/dialog';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { FINDABLE_FROM, TextField } from '../../ui/text-field';
import { useToast } from '../../ui/toast';
import { useSession } from '../session/session';
import { useWorkspaceRole } from '../settings/role';
import { useWorkspace } from '../shell/workspace';
import { forgetChannel } from '../questions/last-channel';
import { AddPeopleDialog } from './add-people';
import { GitHubFeeds } from './github-feeds';
import { IncomingWebhooks } from './incoming-webhooks';
import { ChannelRetentionSection } from './channel-retention';
import { CHANNEL_NAME, finishedChannelName } from './channel-name';
import { typeChannelName } from './name-field';
import { useLeaveRefusal } from './leave';
import { LEVELS, useChooseLevel } from './notification-level-menu';
import { Radio } from '../../ui/checkbox';

const sectionTitle = 'text-label font-semibold text-ink';

/** A row of the danger zone: what the act costs, and the act. */
const dangerRow =
  'flex items-center gap-4 border-border-subtle px-4 py-3 not-first:border-t-hairline max-narrow:gap-3';

/** The name and the topic: a form for a member, two lines for anybody else. */
const NameAndTopic = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const { updateChannel } = useActions();
  const formId = useId();
  // Only what the person edits is theirs; a field they have not touched shows the channel as it is
  // now, so a rename by somebody else appears here and is never sent back over it (D-123 §6).
  const [editedName, setName] = useState<string | null>(null);
  const [editedTopic, setTopic] = useState<string | null>(null);
  const [problem, setProblem] = useState<{
    field: 'name' | 'topic' | 'form';
    message: string;
  } | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'saved'>('idle');
  const name = editedName ?? channel.name ?? '';
  const topic = editedTopic ?? channel.topic ?? '';
  const wanted: UpdateChannelRequest = {
    ...(editedName === null ? {} : { name: finishedChannelName(editedName) }),
    ...(editedTopic === null
      ? {}
      : { topic: editedTopic.trim() === '' ? null : editedTopic.trim() }),
  };
  const changed =
    (wanted.name !== undefined && wanted.name !== channel.name) ||
    (wanted.topic !== undefined && wanted.topic !== channel.topic);

  if (channel.state === null) {
    return (
      <p className="text-body text-ink-muted">
        {channel.topic ?? t('header.noTopic')} · {t('details.onlyMembers')}
      </p>
    );
  }

  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (wanted.name !== undefined && !CHANNEL_NAME.test(wanted.name)) {
      setProblem({ field: 'name', message: t('newChannel.invalid') });
      return;
    }
    setState('busy');
    setProblem(null);
    try {
      await updateChannel(channel.id, wanted);
      setName(null);
      setTopic(null);
      setState('saved');
    } catch (failure) {
      setState('idle');
      if (isApiError(failure) && failure.code === 'CHANNEL_NAME_TAKEN') {
        setProblem({ field: 'name', message: t('newChannel.taken') });
      } else if (isApiError(failure) && failure.code === 'VALIDATION_FAILED') {
        setProblem(
          'topic' in failure.fields
            ? { field: 'topic', message: t('details.topicInvalid') }
            : { field: 'name', message: t('newChannel.invalid') },
        );
      } else {
        setProblem({ field: 'form', message: `${t('details.saveFailed')} ${describe(failure)}` });
      }
    }
  };

  return (
    <form
      id={formId}
      onSubmit={(event) => {
        void submit(event);
      }}
      className="flex flex-col gap-3"
    >
      <TextField
        label={t('details.name')}
        hint={t('newChannel.nameHint')}
        value={name}
        maxLength={CHANNEL_NAME_MAX}
        autoComplete="off"
        spellCheck={false}
        {...(problem?.field === 'name' ? { error: problem.message } : {})}
        onChange={(event) => {
          typeChannelName(event.target, setName);
          setState('idle');
        }}
      />
      <TextField
        label={t('details.topic')}
        hint={t('newChannel.topicHint')}
        value={topic}
        autoComplete="off"
        {...(problem?.field === 'topic' ? { error: problem.message } : {})}
        onChange={(event) => {
          setTopic(event.target.value);
          setState('idle');
        }}
      />
      <div className="flex items-center justify-end gap-3">
        <p role="status" className="min-w-0 flex-1 text-right text-label text-ink-muted">
          {state === 'saved' ? t('details.saved') : ''}
        </p>
        {problem?.field === 'form' && (
          <p role="alert" className="text-label text-danger-text">
            {problem.message}
          </p>
        )}
        <Button type="submit" variant="primary" busy={state === 'busy'} disabled={!changed}>
          {t('details.save')}
        </Button>
      </div>
    </form>
  );
};

/** What the person is told about here, the level said in words and changed in place (D-107). */
const Notifications = ({ channel }: { readonly channel: Channel }): React.JSX.Element | null => {
  const { t } = useI18n();
  const choose = useChooseLevel(channel);
  const name = useId();
  const current = channel.notificationLevel;
  // Only a member has a level; somebody who has not joined is told nothing and offered nothing.
  if (channel.state === null || current === null) return null;
  return (
    <fieldset className="flex flex-col">
      <legend className={cn(sectionTitle, 'mb-2')}>{t('details.notifications')}</legend>
      <div className="flex flex-col rounded-lg border-hairline border-border-subtle">
        {LEVELS.map((level) => (
          <label
            key={level}
            className="flex min-h-row items-center gap-3 border-border-subtle px-3 py-2 text-body text-ink not-first:border-t-hairline max-narrow:min-h-touch"
          >
            <Radio
              name={name}
              value={level}
              checked={level === current}
              onChange={() => {
                choose(level);
              }}
              className="size-icon-md accent-ink"
            />
            {t(`level.${level}`)}
          </label>
        ))}
      </div>
    </fieldset>
  );
};

/**
 * Whether this person may take that one out of the channel — what the server allows (D-172): an owner
 * anybody, an admin anybody but an owner, and a member of a private channel another member whose role
 * is `member`. Never themself (that is Leave), and never in a conversation, whose people never change.
 */
const mayRemove = (
  channel: Channel,
  actor: UserRole | undefined,
  target: UserRole | undefined,
): boolean =>
  channel.type !== 'direct_message' &&
  target !== undefined &&
  (actor === 'owner' ||
    (actor === 'admin' && target !== 'owner') ||
    (channel.type === 'private' && channel.state !== null && target === 'member'));

/** Who is in it, found by name when there are many, the way to bring somebody else in, and to take somebody out. */
const Members = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const { t, format } = useI18n();
  const describe = useDescribeFailure();
  const client = useQueryClient();
  const api = useApi();
  const { user } = useSession();
  const { workspace } = useWorkspace();
  const actor = useWorkspaceRole();
  const people = useMembers(workspace.id);
  const members = useChannelMembers(channel.id);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [asking, setAsking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const headingId = useId();
  const list = useRef<HTMLUListElement>(null);
  // Which row asked, so Cancel gives focus back to its Remove: the question replaces nothing, but
  // focus left on Cancel as it goes falls to the dialog itself.
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (asking !== null) {
      asked.current = asking;
      list.current?.querySelector<HTMLElement>('[data-answer="cancel"]')?.focus();
    } else if (asked.current !== null) {
      list.current?.querySelector<HTMLElement>(`[data-remove="${asked.current}"]`)?.focus();
      asked.current = null;
    }
  }, [asking]);
  const all = members.data ?? [];
  const wanted = fold(query.trim());
  const shown =
    wanted === ''
      ? all
      : all.filter(
          ({ user: person }) =>
            fold(person.displayName).includes(wanted) || fold(person.username).includes(wanted),
        );
  const roleOf = (userId: string): UserRole | undefined =>
    people.data?.find((member) => member.user.id === userId)?.role;

  /** Out of the list at once, and back in it if the server refuses — with the refusal said. */
  const remove = async (person: ChannelMember['user']): Promise<void> => {
    const key = keys.channelMembers(channel.id);
    const before = client.getQueryData<ChannelMember[]>(key);
    asked.current = null;
    setAsking(null);
    setProblem(null);
    client.setQueryData<ChannelMember[]>(key, (now) =>
      now?.filter((member) => member.user.id !== person.id),
    );
    try {
      await api.removeChannelMember(channel.id, person.id);
      // The count the sidebar and Browse show is the server's (D-167).
      void client.invalidateQueries({ queryKey: keys.channels(workspace.id) });
    } catch (failure) {
      client.setQueryData(key, before);
      setProblem(
        isApiError(failure) && failure.code === 'FORBIDDEN'
          ? t('details.removeForbidden', { name: person.displayName })
          : `${t('details.removeFailed', { name: person.displayName })} ${describe(failure)}`,
      );
      void client.invalidateQueries({ queryKey: key });
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex min-h-control items-center justify-between gap-3">
        <h3 id={headingId} className={sectionTitle}>
          {t('details.members', { number: format.number(all.length) })}
        </h3>
        {channel.state !== null && (
          <Button
            glyph="add"
            onClick={() => {
              setAdding(true);
            }}
          >
            {t('people.add')}
          </Button>
        )}
      </div>
      {members.isError ? (
        <div className="flex items-center gap-3">
          <p className="text-body text-ink-muted">
            {`${t('details.membersFailed')} ${describe(members.error)}`}
          </p>
          <Button
            onClick={() => {
              void members.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : members.data === undefined ? (
        <LoadingStatus label={t('common.loading')} className="flex flex-col gap-2">
          <Skeleton />
          <Skeleton />
        </LoadingStatus>
      ) : all.length === 0 ? (
        <p className="text-body text-ink-muted">{t('details.nobody')}</p>
      ) : (
        <>
          {all.length > FINDABLE_FROM && (
            <TextField
              label={t('details.find')}
              type="search"
              value={query}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          )}
          {shown.length === 0 ? (
            <p role="status" className="text-body text-ink-muted">
              {t('details.noMatch', { query: query.trim() })}
            </p>
          ) : (
            <ul
              ref={list}
              className="flex max-h-palette-list flex-col overflow-y-auto rounded-lg border-hairline border-border-subtle"
            >
              {shown.map(({ user: person }) => {
                const you = person.id === user.id;
                const removable = !you && mayRemove(channel, actor, roleOf(person.id));
                return (
                  <li
                    key={person.id}
                    className="flex flex-col border-border-subtle not-first:border-t-hairline"
                  >
                    <div className="flex min-h-row items-center gap-3 px-3 py-2 max-narrow:min-h-touch">
                      <Avatar name={person.displayName} username={person.username} size="md" />
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="truncate text-body text-ink">{person.displayName}</span>
                        <span className="truncate text-caption text-ink-muted">
                          @{person.username}
                        </span>
                      </span>
                      {you && (
                        <span className="shrink-0 text-caption text-ink-muted">
                          {t('details.you')}
                        </span>
                      )}
                      {removable && asking !== person.id && (
                        <Button
                          variant="dangerQuiet"
                          data-remove={person.id}
                          aria-label={t('details.removeLabel', { name: person.displayName })}
                          onClick={() => {
                            setProblem(null);
                            setAsking(person.id);
                          }}
                        >
                          {t('details.remove')}
                        </Button>
                      )}
                    </div>
                    {asking === person.id && (
                      <div
                        role="group"
                        aria-label={t('details.removeLabel', { name: person.displayName })}
                        className="flex items-center gap-3 bg-danger-subtle px-3 py-2 max-narrow:flex-col max-narrow:items-stretch"
                      >
                        <p className="min-w-0 flex-1 text-label text-danger-text">
                          {t(
                            channel.type === 'private'
                              ? 'details.removeAsk.private'
                              : 'details.removeAsk.public',
                            { name: person.displayName, channel: channel.name ?? '' },
                          )}
                        </p>
                        <span className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            data-answer="cancel"
                            onClick={() => {
                              setAsking(null);
                            }}
                          >
                            {t('common.cancel')}
                          </Button>
                          <Button
                            variant="danger"
                            onClick={() => {
                              void remove(person);
                            }}
                          >
                            {t('details.remove')}
                          </Button>
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {problem !== null && (
        <p role="alert" className="text-label text-danger-text">
          {problem}
        </p>
      )}
      {channel.state !== null && (
        <AddPeopleDialog
          channel={channel}
          open={adding}
          onOpenChange={(next) => {
            setAdding(next);
            // Whoever was brought in is in the list when it is shown again.
            if (!next) void client.invalidateQueries({ queryKey: keys.channelMembers(channel.id) });
          }}
        />
      )}
    </section>
  );
};

/**
 * Leave, for a member, and Archive, for an owner or an admin: each asks in place first, says what it
 * costs, and when done takes the person to the workspace and says so in a toast.
 */
const Farewell = ({ channel }: { readonly channel: Channel }): React.JSX.Element | null => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const { leaveChannel, archiveChannel } = useActions();
  const leaveRefusal = useLeaveRefusal();
  const { workspace } = useWorkspace();
  const { memberships } = useSession();
  const { navigate } = useRoute();
  const { show } = useToast();
  const [asking, setAsking] = useState<'leave' | 'archive' | null>(null);
  const [busy, setBusy] = useState(false);
  const questionId = useId();
  const headingId = useId();
  const box = useRef<HTMLDivElement>(null);
  // Which button asked, so Cancel can give focus back to it: the question replaces the buttons, and
  // focus on a button that is gone falls to the dialog itself, far from where the person was.
  const asked = useRef<'leave' | 'archive' | null>(null);
  useEffect(() => {
    if (asking !== null) {
      asked.current = asking;
      box.current?.querySelector<HTMLElement>('[data-answer="cancel"]')?.focus();
    } else if (asked.current !== null) {
      box.current?.querySelector<HTMLElement>(`[data-ask="${asked.current}"]`)?.focus();
      asked.current = null;
    }
  }, [asking]);
  const [problem, setProblem] = useState<string | null>(null);
  const role = memberships.find((m) => m.workspace.id === workspace.id)?.role;
  const member = channel.state !== null;
  const archiver = role === 'owner' || role === 'admin';
  const name = channel.name ?? '';
  if (!member && !archiver) return null;

  const act = async (what: 'leave' | 'archive'): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      if (what === 'leave') await leaveChannel(channel);
      else await archiveChannel(channel.id);
      forgetChannel(workspace.id, channel.id);
      show({ message: t(what === 'leave' ? 'details.left' : 'details.archived', { name }) });
      navigate(href('workspace', { slug: workspace.slug }));
    } catch (failure) {
      setBusy(false);
      setProblem(
        what === 'leave'
          ? leaveRefusal(failure)
          : `${t('details.archiveFailed')} ${describe(failure)}`,
      );
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col">
      <h3 id={headingId} className={cn(sectionTitle, 'mb-2')}>
        {t('details.danger')}
      </h3>
      <div ref={box} className="flex flex-col rounded-lg border-hairline border-danger">
        {asking === null ? (
          <>
            {member && (
              <div className={dangerRow}>
                <p className="min-w-0 flex-1 text-body text-ink-muted">{t('details.leaveHint')}</p>
                <Button
                  variant="dangerQuiet"
                  data-ask="leave"
                  onClick={() => {
                    setAsking('leave');
                  }}
                >
                  {t('details.leave')}
                </Button>
              </div>
            )}
            {archiver && (
              <div className={dangerRow}>
                <p className="min-w-0 flex-1 text-body text-ink-muted">
                  {t('details.archiveHint')}
                </p>
                <Button
                  variant="dangerQuiet"
                  data-ask="archive"
                  onClick={() => {
                    setAsking('archive');
                  }}
                >
                  {t('details.archive')}
                </Button>
              </div>
            )}
          </>
        ) : (
          <div role="group" aria-labelledby={questionId} className="flex flex-col gap-3 p-4">
            <p id={questionId} className="text-body text-ink">
              {t(asking === 'leave' ? 'details.leaveAsk' : 'details.archiveAsk', { name })}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                data-answer="cancel"
                onClick={() => {
                  setAsking(null);
                  setProblem(null);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                busy={busy}
                onClick={() => {
                  void act(asking);
                }}
              >
                {t(asking === 'leave' ? 'details.leave' : 'details.archive')}
              </Button>
            </div>
          </div>
        )}
      </div>
      {problem !== null && (
        <p role="alert" className="mt-2 text-label text-danger-text">
          {problem}
        </p>
      )}
    </section>
  );
};

type Tab = 'about' | 'members' | 'integrations';

/**
 * The tabs (WAI-ARIA's pattern, activated as they are reached): one tab in the Tab order, ← → move
 * between them and wrap, Home and End go to the ends. Every panel stays mounted and only the chosen
 * one is shown, so a name half typed in About is still there after a look at Members.
 */
const Details = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const { t, format } = useI18n();
  const { workspace } = useWorkspace();
  const { memberships } = useSession();
  const members = useChannelMembers(channel.id);
  const [tab, setTab] = useState<Tab>('about');
  const tabsRef = useRef<HTMLDivElement>(null);
  const base = useId();
  // Repository feeds and incoming webhooks are an owner's or an admin's to see and set up (D-134 §2, D-245).
  const role = memberships.find((m) => m.workspace.id === workspace.id)?.role;
  const configures = (role === 'owner' || role === 'admin') && channel.type !== 'direct_message';
  const tabs: readonly Tab[] = configures
    ? ['about', 'members', 'integrations']
    : ['about', 'members'];

  const move = (event: React.KeyboardEvent): void => {
    const at = tabs.indexOf(tab);
    const to =
      event.key === 'ArrowRight'
        ? (at + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (at - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : null;
    const next = to === null ? undefined : tabs[to];
    if (next === undefined) return;
    event.preventDefault();
    setTab(next);
    tabsRef.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };

  return (
    <>
      {/* The rule under the tabs is drawn behind them, so the chosen tab's mark lies on it rather
      than above it. */}
      <div className="relative">
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 border-b-hairline border-border-subtle"
        />
        <div
          ref={tabsRef}
          role="tablist"
          aria-label={t('details.tabs')}
          onKeyDown={move}
          className="relative flex gap-5"
        >
          {tabs.map((each) => (
            <button
              key={each}
              type="button"
              role="tab"
              id={`${base}-${each}-tab`}
              data-tab={each}
              aria-selected={each === tab}
              aria-controls={`${base}-${each}`}
              tabIndex={each === tab ? 0 : -1}
              onClick={() => {
                setTab(each);
              }}
              className={cn(
                'flex h-control items-center gap-2 border-b-marker text-label transition-colors duration-hover ease-standard max-narrow:h-touch',
                each === tab
                  ? 'border-accent text-ink'
                  : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              {t(`details.tab.${each}`)}
              {each === 'members' && members.data !== undefined && (
                <span className="text-caption text-ink-muted">
                  {format.number(members.data.length)}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
      {tabs.map((each) => (
        <div
          key={each}
          role="tabpanel"
          id={`${base}-${each}`}
          aria-labelledby={`${base}-${each}-tab`}
          hidden={each !== tab}
          className="flex flex-col gap-6 pt-2"
        >
          {each === 'about' && (
            <>
              <NameAndTopic channel={channel} />
              <Notifications channel={channel} />
              {/* How long it keeps its history is an owner's, as the workspace's is (D-225). */}
              {role === 'owner' && channel.type !== 'direct_message' && (
                <ChannelRetentionSection channel={channel} />
              )}
              <Farewell channel={channel} />
            </>
          )}
          {each === 'members' && <Members channel={channel} />}
          {each === 'integrations' && (
            <>
              <GitHubFeeds channel={channel} />
              {/* An owner's or an admin's, as a feed is (D-245). */}
              <IncomingWebhooks channel={channel} />
            </>
          )}
        </div>
      ))}
    </>
  );
};

export const ChannelDetailsDialog = ({
  channel,
  open,
  onOpenChange,
}: {
  readonly channel: Channel;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('details.title', { name: channel.name ?? '' })}
      description={t('details.description')}
      closeLabel={t('common.close')}
      size="wide"
      // Read first: the name field is not where the person is going, and one key would rename it.
      focusFirst="dialog"
    >
      <Details channel={channel} />
    </Dialog>
  );
};
