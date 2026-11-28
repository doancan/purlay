/**
 * Issues (D-254): a workspace's list of things to do — make one, mark it done or open again, change its title,
 * details and assignee, delete it. The smallest screen that exercises the module end to end; nothing hangs off an
 * issue.
 *
 * - **Painted from the server's answer**, not guessed: every change asks, then reads the list again, and a refusal
 *   is a toast that says why.
 * - **Delete is offered to the one who made the issue and to the workspace's owners and admins**, the rule the server
 *   holds (`features/issues/issues.ts`); anyone else is not shown the button.
 * - **The details are shown as the text they are**, a few lines of them: rendering markdown is chat's work, and the
 *   module does not borrow it.
 *
 * This file is the module's chunk (`manifest.ts`): nothing the shell loads first imports it, and `budget:web` looks for
 * `ISSUES_SCREEN` in the initial chunks.
 */
import { useId, useMemo, useState } from 'react';
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import {
  ISSUE_BODY_MAX,
  ISSUE_TITLE_MAX,
  type Issue,
  type IssuePage,
  type IssueStatus,
  type UpdateIssueRequest,
  type WorkspaceMember,
} from '@purlay/types';
import { Icon, type GlyphName } from '../../components/icon';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useMembers } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { useArrivals, type ArrivalProps } from '../../ui/arrival';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import {
  ListCard,
  ListColumn,
  ListFilter,
  ListSkeleton,
  listRowClasses,
  ListHeader,
} from '../../ui/list-column';
import { Select } from '../../ui/select';
import { ErrorState, GlyphEmptyState } from '../../ui/states';
import { TextField } from '../../ui/text-field';
import { useToast } from '../../ui/toast';
import { useSession } from '../session/session';
import { useWorkspaceRole } from '../settings/role';
import { NavToggle } from '../shell/nav';
import { useWorkspace } from '../shell/workspace';
import type { IssuesScreens } from './manifest';
import { ConfirmDialog } from '../../ui/confirm-dialog';

/** What `budget:web` looks for in the initial chunks: this screen's code must never be among them. */
export const ISSUES_SCREEN = 'screen-of-the-issues-module';

const FILTERS = ['all', 'open', 'done'] as const;
type Filter = (typeof FILTERS)[number];

/** The filter an address names; All for anything else. */
export const filterIn = (search: string): Filter => {
  const named = new URLSearchParams(search).get('status');
  return FILTERS.find((filter) => filter === named) ?? 'all';
};

const pagesKey = (workspaceId: string, filter: Filter): readonly unknown[] => [
  ...keys.issues(workspaceId),
  'pages',
  filter,
];

const useIssues = (
  workspaceId: string,
  filter: Filter,
): UseInfiniteQueryResult<InfiniteData<IssuePage>> => {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: pagesKey(workspaceId, filter),
    queryFn: ({ pageParam, signal }) =>
      api.issues(
        workspaceId,
        {
          ...(filter === 'all' ? {} : { status: filter }),
          ...(pageParam === undefined ? {} : { before: pageParam }),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
};

/** Asks, reads the list again either way, and says why when the server refused. */
const useChange = (): ((ask: () => Promise<unknown>, failed: string) => Promise<boolean>) => {
  const { workspace } = useWorkspace();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  return async (ask, failed) => {
    try {
      await ask();
      return true;
    } catch (failure) {
      show({ message: `${failed} ${describe(failure)}` });
      return false;
    } finally {
      await client.invalidateQueries({ queryKey: keys.issues(workspace.id) });
    }
  };
};

const NewIssue = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const api = useApi();
  const change = useChange();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex items-end gap-3 max-narrow:flex-col max-narrow:items-stretch"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void change(
          () => api.createIssue(workspace.id, { title: title.trim() }),
          t('issues.new.failed'),
        ).then((made) => {
          if (made) setTitle('');
          setBusy(false);
        });
      }}
    >
      <div className="min-w-0 flex-1">
        <TextField
          label={t('issues.new.title')}
          placeholder={t('issues.new.placeholder')}
          value={title}
          maxLength={ISSUE_TITLE_MAX}
          autoComplete="off"
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
      </div>
      <Button
        type="submit"
        variant="primary"
        glyph="add"
        busy={busy}
        disabled={title.trim() === ''}
      >
        {t('issues.new.add')}
      </Button>
    </form>
  );
};

interface EditFormProps {
  readonly issue: Issue;
  readonly members: readonly WorkspaceMember[];
  readonly onDone: () => void;
}

const EditForm = ({ issue, members, onDone }: EditFormProps): React.JSX.Element => {
  const { t, format } = useI18n();
  const { workspace } = useWorkspace();
  const api = useApi();
  const change = useChange();
  const bodyId = useId();
  const assigneeId = useId();
  const [title, setTitle] = useState(issue.title);
  const [body, setBody] = useState(issue.body);
  const [assignee, setAssignee] = useState(issue.assigneeId ?? '');
  const [busy, setBusy] = useState(false);
  const known = members.some((member) => member.user.id === issue.assigneeId);

  const save = (): void => {
    const input: UpdateIssueRequest = {
      ...(title.trim() === issue.title ? {} : { title: title.trim() }),
      ...(body === issue.body ? {} : { body }),
      ...(assignee === (issue.assigneeId ?? '')
        ? {}
        : { assigneeId: assignee === '' ? null : assignee }),
    };
    if (Object.keys(input).length === 0) {
      onDone();
      return;
    }
    setBusy(true);
    void change(
      () => api.updateIssue(workspace.id, issue.id, input),
      t('issues.updateFailed'),
    ).then((saved) => {
      setBusy(false);
      if (saved) onDone();
    });
  };

  return (
    <form
      className="flex flex-col gap-3 px-5 py-3 max-narrow:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <TextField
        label={t('issues.editTitle')}
        value={title}
        maxLength={ISSUE_TITLE_MAX}
        autoComplete="off"
        onChange={(event) => {
          setTitle(event.target.value);
        }}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor={bodyId} className="text-label text-ink">
          {t('issues.editBody')}
        </label>
        <textarea
          id={bodyId}
          rows={5}
          value={body}
          maxLength={ISSUE_BODY_MAX}
          aria-describedby={`${bodyId}-hint`}
          className="w-full resize-y rounded-md border-hairline border-border-strong bg-surface-100 px-3 py-2 text-body text-ink max-narrow:text-title max-narrow:font-normal"
          onChange={(event) => {
            setBody(event.target.value);
          }}
        />
        <p id={`${bodyId}-hint`} className="text-caption text-ink-muted">
          {t('issues.editBodyHint', { max: format.number(ISSUE_BODY_MAX) })}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={assigneeId} className="text-label text-ink">
          {t('issues.editAssignee')}
        </label>
        <Select
          id={assigneeId}
          className="self-start max-narrow:self-stretch"
          value={assignee}
          onChange={(event) => {
            setAssignee(event.target.value);
          }}
        >
          <option value="">{t('issues.nobody')}</option>
          {/* Somebody who left stays what the issue says, until it is given to somebody else. */}
          {!known && issue.assigneeId !== null && (
            <option value={issue.assigneeId}>{t('issues.assignedFormer')}</option>
          )}
          {members.map((member) => (
            <option key={member.user.id} value={member.user.id}>
              {member.user.displayName}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" busy={busy} disabled={title.trim() === ''}>
          {t('issues.save')}
        </Button>
      </div>
    </form>
  );
};

/** Where an issue stands, as a pill: open is neutral, done is the success the work came to. */
const statusPillClasses =
  'inline-flex h-badge shrink-0 items-center gap-1 rounded-pill px-2 text-caption font-medium';
const statusTone: Record<IssueStatus, string> = {
  open: 'bg-surface-200 text-ink-muted',
  done: 'bg-success-subtle text-success-text',
};
/** One mark for each status, on its pill and on the button that moves an issue to it. */
const statusGlyph: Record<IssueStatus, GlyphName> = { open: 'issues', done: 'resolved' };

interface RowProps {
  readonly issue: Issue;
  readonly members: readonly WorkspaceMember[];
  readonly canDelete: boolean;
  /** Drawn arriving once, when this issue was just added to the list on screen. */
  readonly arrival: ArrivalProps;
}

const Row = ({ issue, members, canDelete, arrival }: RowProps): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const api = useApi();
  const change = useChange();
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const assignee =
    issue.assigneeId === null
      ? null
      : (members.find((member) => member.user.id === issue.assigneeId)?.user.displayName ?? null);
  const moved: IssueStatus = issue.status === 'open' ? 'done' : 'open';

  if (editing) {
    return (
      <li className={listRowClasses}>
        <EditForm
          issue={issue}
          members={members}
          onDone={() => {
            setEditing(false);
          }}
        />
      </li>
    );
  }
  return (
    <li {...arrival} className={cn(listRowClasses, 'data-arrived:animate-arrive')}>
      <div className="flex flex-col gap-1 px-5 py-3 max-narrow:px-4">
        <div className="flex items-baseline gap-3">
          <h2
            className={
              issue.status === 'done'
                ? 'min-w-0 flex-1 text-body font-semibold text-ink-muted line-through'
                : 'min-w-0 flex-1 text-body font-semibold text-ink'
            }
          >
            {issue.title}
          </h2>
          <span className={cn(statusPillClasses, statusTone[issue.status])}>
            <Icon name={statusGlyph[issue.status]} size="sm" />
            {t(`issues.status.${issue.status}`)}
          </span>
        </div>
        {issue.body !== '' && (
          <p className="line-clamp-3 whitespace-pre-wrap text-body text-ink-muted">{issue.body}</p>
        )}
        {issue.assigneeId !== null && (
          <p className="text-caption text-ink-muted">
            {assignee === null
              ? t('issues.assignedFormer')
              : t('issues.assignedTo', { name: assignee })}
          </p>
        )}
        {/* Ghost buttons have no edge: drawn out by their inset, their glyphs stand under the title's first letter. */}
        <div className="-ml-3 flex flex-wrap gap-1 pt-1">
          <Button
            variant="ghost"
            glyph={statusGlyph[moved]}
            onClick={() => {
              void change(
                () => api.updateIssue(workspace.id, issue.id, { status: moved }),
                t('issues.updateFailed'),
              );
            }}
          >
            {t(issue.status === 'open' ? 'issues.markDone' : 'issues.reopen')}
          </Button>
          <Button
            variant="ghost"
            glyph="edit"
            onClick={() => {
              setEditing(true);
            }}
          >
            {t('issues.edit')}
          </Button>
          {canDelete && (
            <Button
              variant="dangerQuiet"
              glyph="delete"
              onClick={() => {
                setAsking(true);
              }}
            >
              {t('issues.delete')}
            </Button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={t('issues.deleteTitle')}
        description={t('issues.deleteBody')}
        confirmLabel={t('issues.delete')}
        confirmGlyph="delete"
        onConfirm={() => {
          void change(() => api.deleteIssue(workspace.id, issue.id), t('issues.deleteFailed'));
        }}
      />
    </li>
  );
};

export const IssuesScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate, search } = useRoute();
  const { user } = useSession();
  const role = useWorkspaceRole();
  const filter = filterIn(search);
  const query = useIssues(workspace.id, filter);
  const members = useMembers(workspace.id).data ?? [];
  const issues = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.data),
    [query.data],
  );
  const admin = role === 'owner' || role === 'admin';
  // An issue just added rises into the list where it now stands; the first page, and a filter's, are not arrivals.
  const arrival = useArrivals(
    query.data === undefined ? undefined : issues.map((issue) => issue.id),
    filter,
  );

  let body: React.JSX.Element;
  if (query.isPending) {
    body = <ListSkeleton label={t('issues.loading')} />;
  } else if (query.isError && query.data === undefined) {
    body = (
      <ErrorState
        framed
        title={t('issues.error.title')}
        body={t('issues.error.body')}
        retryLabel={t('common.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (issues.length === 0) {
    body = (
      <GlyphEmptyState
        glyph="issues"
        tone="accent"
        title={t(`issues.empty.${filter}`)}
        body={t('issues.empty.body')}
      />
    );
  } else {
    body = (
      <>
        <ListCard label={t('issues.title')}>
          {issues.map((issue) => (
            <Row
              key={issue.id}
              arrival={arrival(issue.id)}
              issue={issue}
              members={members}
              canDelete={admin || issue.createdBy === user.id}
            />
          ))}
        </ListCard>
        {query.hasNextPage && (
          <div className="flex justify-center">
            <Button
              variant="secondary"
              busy={query.isFetchingNextPage}
              onClick={() => {
                void query.fetchNextPage();
              }}
            >
              {t('issues.more')}
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <div data-screen={ISSUES_SCREEN} className="flex min-h-0 flex-1 flex-col">
      <ListHeader>
        <div data-header-title="" className="flex min-w-0 flex-1 items-center gap-2">
          <NavToggle />
          <span
            aria-hidden="true"
            className="inline-flex shrink-0 text-ink-subtle max-narrow:hidden"
          >
            <Icon name="issues" size="lg" />
          </span>
          <h1 className="whitespace-nowrap text-heading text-ink">{t('issues.title')}</h1>
        </div>
      </ListHeader>
      <ListColumn>
        <NewIssue />
        <ListFilter
          label={t('issues.filter')}
          value={filter}
          choices={FILTERS.map((choice) => ({
            value: choice,
            label: t(`issues.filter.${choice}`),
          }))}
          onChange={(choice) => {
            navigate(
              choice === 'all'
                ? href('issues', { slug: workspace.slug })
                : `${href('issues', { slug: workspace.slug })}?status=${choice}`,
            );
          }}
        />
        {body}
      </ListColumn>
    </div>
  );
};

/** What the manifest's `load` reads: the screen of each of the module's routes. */
export const screens: IssuesScreens = { issues: IssuesScreen };
