/**
 * A thread's GitHub work, and making an issue from it (D-246 §2, §4): what the root already points at, and a
 * review in which the person sees the exact text and the destination before anything is sent.
 *
 * Drawn only where the workspace has an installation in use — otherwise nothing of GitHub is offered. Making
 * an issue needs the person's own authorization, asked for here when it is missing and never at sign-in. The
 * request id is made once per dialog and kept while GitHub's answer is not known, so Check again is the same
 * request — the server finds the issue by its marker rather than making a second. Whatever is edited after an
 * answer is a new request with a new id. Nothing here resolves the question.
 */
import {
  GITHUB_ISSUE_BODY_MAX,
  GITHUB_ISSUE_TITLE_MAX,
  githubIssueMarker,
  type GitHubIssueOutcome,
  type GitHubRepository,
  type Message,
} from '@purlay/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useApi } from '../../data/api-provider';
import { codeOf } from '../../data/failure';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { threadHref } from '../../router/routes';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { Dialog } from '../../ui/dialog';
import { Select } from '../../ui/select';
import { TextField } from '../../ui/text-field';
import { Note } from '../setup/parts';
import { leave } from '../sign-in/leave';
import { useWorkspace } from '../shell/workspace';

/** The first line of the question, cut to what a title may be. */
const titleOf = (content: string): string =>
  (content.split('\n')[0] ?? '')
    .replace(/^[#>\s*_-]+/, '')
    .trim()
    .slice(0, GITHUB_ISSUE_TITLE_MAX);

export const GitHubWorkPanel = ({
  root,
  member,
  channelIsPublic,
}: {
  readonly root: Message;
  readonly member: boolean;
  readonly channelIsPublic: boolean;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const api = useApi();
  const { workspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  const status = useQuery({
    queryKey: keys.githubApp(workspace.id),
    queryFn: async ({ signal }) => await api.githubApp(workspace.id, signal),
  });
  const work = root.thread?.githubWork ?? [];
  const installed =
    status.data?.available === true &&
    status.data.installation !== null &&
    !status.data.installation.suspended;
  const mayCreate = installed && member && root.deletedAt === null;
  if (work.length === 0 && !mayCreate) return null;
  return (
    <section
      className="mx-2 mt-3 flex flex-col gap-2 rounded-lg border-hairline border-border-subtle bg-surface-050 p-3"
      aria-label={t('githubIssue.work.title')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-label font-semibold text-ink">{t('githubIssue.work.title')}</h3>
        {mayCreate && (
          <Button
            variant="ghost"
            onClick={() => {
              setOpen(true);
            }}
          >
            {t('githubIssue.work.create')}
          </Button>
        )}
      </div>
      {work.length > 0 && (
        <ul className="flex flex-col gap-1">
          {work.map((link) => (
            <li key={link.id} className="flex flex-wrap items-baseline gap-2 text-body">
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="break-all text-accent-text hover:underline"
              >
                {`${link.repository}#${String(link.number)}`}
              </a>
              <span className="min-w-0 break-words text-ink">{link.title}</span>
              <span className="text-caption text-ink-muted">{t(`github.state.${link.state}`)}</span>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <GitHubIssueDialog
          root={root}
          channelIsPublic={channelIsPublic}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </section>
  );
};

/** What the issue starts as, in the person's own language: the question, its answer and decision, and the way back. */
const draftOf = (root: Message, address: string, t: ReturnType<typeof useI18n>['t']): string => {
  const knowledge = root.thread?.knowledge;
  const parts = [root.content];
  if (knowledge?.acceptedAnswer != null) {
    parts.push(`**${t('githubIssue.draft.answer')}**\n${knowledge.acceptedAnswer.content}`);
  }
  if (knowledge !== undefined && knowledge.decisionNote !== '') {
    parts.push(`**${t('githubIssue.draft.decision')}**\n${knowledge.decisionNote}`);
  }
  parts.push(`[${t('githubIssue.draft.source')}](${address})`);
  return parts.join('\n\n').slice(0, GITHUB_ISSUE_BODY_MAX);
};

type Result =
  | { readonly kind: 'none' }
  | { readonly kind: 'outcome'; readonly outcome: GitHubIssueOutcome }
  | { readonly kind: 'failed'; readonly words: string };

const GitHubIssueDialog = ({
  root,
  channelIsPublic,
  onClose,
}: {
  readonly root: Message;
  readonly channelIsPublic: boolean;
  readonly onClose: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { workspace } = useWorkspace();
  const field = useId();
  const here = threadHref(workspace.slug, root.channelId, root.id);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [repositoryId, setRepositoryId] = useState<number | null>(null);
  const [title, setTitle] = useState(() => titleOf(root.content));
  const [body, setBody] = useState(() => draftOf(root, `${window.location.origin}${here}`, t));
  const [copy, setCopy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>({ kind: 'none' });

  const status = useQuery({
    queryKey: keys.githubApp(workspace.id),
    queryFn: async ({ signal }) => await api.githubApp(workspace.id, signal),
  });
  const authorization = status.data?.authorization ?? null;
  const repositories = useQuery({
    queryKey: keys.githubRepositories(workspace.id),
    queryFn: async ({ signal }) => await api.githubRepositories(workspace.id, signal),
    enabled: authorization !== null,
    // What GitHub lists for this person now: asked again each time the dialog opens, never kept.
    gcTime: 0,
    retry: false,
  });
  const choices: readonly GitHubRepository[] = repositories.data?.repositories ?? [];
  const chosen = choices.find((choice) => choice.id === (repositoryId ?? choices[0]?.id));

  // What is waiting on GitHub is not changed: the same words are the same request.
  const locked =
    busy ||
    (result.kind === 'outcome' &&
      (result.outcome.status === 'pending' || result.outcome.status === 'unknown'));
  const edited = (change: () => void): void => {
    change();
    if (result.kind === 'outcome' && result.outcome.status !== 'created') {
      setRequestId(crypto.randomUUID());
    }
    if (result.kind === 'outcome' || result.kind === 'failed') setResult({ kind: 'none' });
  };

  const send = async (): Promise<void> => {
    if (chosen === undefined || busy) return;
    setBusy(true);
    try {
      const outcome = await api.createGitHubIssue(root.id, {
        clientRequestId: requestId,
        repositoryId: chosen.id,
        title: title.trim(),
        body,
        copyPrivateText: !channelIsPublic && copy,
      });
      setResult({ kind: 'outcome', outcome });
    } catch (failure) {
      if (codeOf(failure) === 'GITHUB_AUTHORIZATION_REQUIRED') {
        await client.invalidateQueries({ queryKey: keys.githubApp(workspace.id) });
        setResult({ kind: 'none' });
      } else {
        setResult({ kind: 'failed', words: describe(failure) });
      }
    } finally {
      setBusy(false);
    }
  };

  const authorize = async (): Promise<void> => {
    setBusy(true);
    try {
      leave.to((await api.startGitHubAuthorization(here)).url);
    } catch (failure) {
      setResult({ kind: 'failed', words: describe(failure) });
      setBusy(false);
    }
  };

  const created =
    result.kind === 'outcome' && result.outcome.status === 'created' ? result.outcome.link : null;
  const text = `${body}${body === '' ? '' : '\n\n'}${githubIssueMarker(requestId)}`;
  const ready =
    chosen !== undefined && title.trim() !== '' && (channelIsPublic || copy) && created === null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={t('githubIssue.dialog.title')}
      description={t('githubIssue.dialog.description')}
      closeLabel={t('common.close')}
      size="wide"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {created === null ? t('common.cancel') : t('githubIssue.done')}
          </Button>
          {authorization !== null && created === null && (
            <Button
              variant="primary"
              busy={busy}
              disabled={!ready || busy}
              onClick={() => {
                void send();
              }}
            >
              {result.kind === 'outcome' &&
              (result.outcome.status === 'pending' || result.outcome.status === 'unknown')
                ? t('githubIssue.state.checkAgain')
                : result.kind === 'failed'
                  ? t('githubIssue.state.tryAgain')
                  : t('githubIssue.create')}
            </Button>
          )}
        </>
      }
    >
      {status.isPending ? null : authorization === null ? (
        <div className="flex flex-col gap-3">
          <p className="text-body text-ink">{t('githubIssue.authorize.body')}</p>
          <div>
            <Button
              variant="primary"
              busy={busy}
              onClick={() => {
                void authorize();
              }}
            >
              {t('githubIssue.authorize.action')}
            </Button>
          </div>
          {result.kind === 'failed' && <Note tone="warn">{result.words}</Note>}
        </div>
      ) : repositories.isError ? (
        <div className="flex flex-col gap-3">
          <Note tone="warn">{`${t('githubIssue.repository.failed')} ${describe(repositories.error)}`}</Note>
          <div>
            <Button
              onClick={() => {
                void repositories.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        </div>
      ) : repositories.isPending ? null : choices.length === 0 ? (
        <Note tone="warn">{t('githubIssue.repository.empty')}</Note>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !busy) void send();
          }}
        >
          <div className="flex flex-col gap-1 text-label text-ink">
            <label htmlFor={`${field}-repository`}>{t('githubIssue.repository.label')}</label>
            <Select
              id={`${field}-repository`}
              value={String(chosen?.id ?? '')}
              disabled={locked}
              onChange={(event) => {
                edited(() => {
                  setRepositoryId(Number(event.target.value));
                });
              }}
            >
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.private
                    ? t('githubIssue.repository.private', { name: choice.fullName })
                    : choice.fullName}
                </option>
              ))}
            </Select>
          </div>
          <TextField
            label={t('githubIssue.title.label')}
            value={title}
            maxLength={GITHUB_ISSUE_TITLE_MAX}
            disabled={locked}
            onChange={(event) => {
              edited(() => {
                setTitle(event.target.value);
              });
            }}
          />
          <div className="flex flex-col gap-1 text-label text-ink">
            <label htmlFor={`${field}-body`}>{t('githubIssue.body.label')}</label>
            <textarea
              id={`${field}-body`}
              rows={8}
              value={body}
              maxLength={GITHUB_ISSUE_BODY_MAX}
              disabled={locked}
              className="w-full resize-y rounded-md border-hairline border-border-strong bg-surface-100 px-3 py-2 font-mono text-caption text-ink"
              onChange={(event) => {
                edited(() => {
                  setBody(event.target.value);
                });
              }}
            />
          </div>
          {!channelIsPublic && (
            <label className="flex items-start gap-2 text-body text-ink">
              <Checkbox
                checked={copy}
                disabled={locked}
                onChange={(event) => {
                  edited(() => {
                    setCopy(event.target.checked);
                  });
                }}
              />
              {t('githubIssue.copy.label')}
            </label>
          )}
          <section
            aria-label={t('githubIssue.review.heading')}
            className="flex flex-col gap-2 rounded-md border-hairline border-border-subtle bg-surface-050 p-3"
          >
            <h3 className="text-label font-semibold text-ink">{t('githubIssue.review.heading')}</h3>
            <p className="text-caption text-ink-muted">
              {t('githubIssue.review.destination', {
                repository: chosen?.fullName ?? '',
                login: authorization.login,
              })}
            </p>
            <p className="break-words text-body font-semibold text-ink">{title}</p>
            <pre className="max-h-code overflow-auto whitespace-pre-wrap break-words font-mono text-caption text-ink">
              {text}
            </pre>
            <p className="text-caption text-ink-muted">{t('githubIssue.review.marker')}</p>
          </section>
          {result.kind === 'failed' && <Note tone="warn">{result.words}</Note>}
          {result.kind === 'outcome' && <Outcome outcome={result.outcome} />}
        </form>
      )}
    </Dialog>
  );
};

/** What GitHub's answer comes to, in words; a created issue is a link to it. */
const Outcome = ({ outcome }: { readonly outcome: GitHubIssueOutcome }): React.JSX.Element => {
  const { t } = useI18n();
  switch (outcome.status) {
    case 'created':
      return (
        <Note tone="good">
          {t('githubIssue.state.created', {
            repository: outcome.link.repository,
            number: String(outcome.link.number),
          })}{' '}
          <a
            href={outcome.link.url}
            target="_blank"
            rel="noreferrer"
            className="break-all underline"
          >
            {outcome.link.url}
          </a>
        </Note>
      );
    case 'pending':
      return <Note tone="warn">{t('githubIssue.state.pending')}</Note>;
    case 'unknown':
      return <Note tone="warn">{t('githubIssue.state.unknown')}</Note>;
    case 'refused':
      return <Note tone="warn">{t(`githubIssue.state.refused.${outcome.reason}`)}</Note>;
  }
};
