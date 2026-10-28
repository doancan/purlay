import { knowledgeInput } from './knowledge-input';
import { useEffect, useId, useRef, useState } from 'react';
import type { Message, SetKnowledgeRequest } from '@purlay/types';
import { DECISION_NOTE_MAX } from '@purlay/types';
import { useActions } from '../../data/actions-provider';
import { useChannelMembers } from '../../data/queries';
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import { messageHref } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { Select } from '../../ui/select';
import { TextField } from '../../ui/text-field';
import { useWorkspace } from '../shell/workspace';
import { renderContent } from '../content/render-content';

/** The decision is read with its source; editing is a deliberate, versioned form. */
export const KnowledgePanel = ({
  root,
  replies,
  member,
}: {
  readonly root: Message;
  readonly replies: readonly Message[];
  readonly member: boolean;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const actions = useActions();
  const describe = useDescribeFailure();
  const [draft, setDraft] = useState<SetKnowledgeRequest | null>(null);
  const members = useChannelMembers(root.channelId, member && draft !== null);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (draft === null && wasEditing.current) {
      editButton.current?.focus();
      wasEditing.current = false;
    }
  }, [draft]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const field = useId();
  const kept = root.thread?.knowledge;
  if (root.deletedAt !== null) return null;
  const start = (): void => {
    wasEditing.current = true;
    setDraft(knowledgeInput(root));
    setError('');
  };
  const save = async (): Promise<void> => {
    if (draft === null || busy) return;
    setBusy(true);
    setError('');
    try {
      await actions.setKnowledge(root, draft);
      setDraft(null);
    } catch (failure) {
      setError(
        isApiError(failure) && failure.code === 'KNOWLEDGE_CONFLICT'
          ? t('knowledge.conflict')
          : describe(failure),
      );
    } finally {
      setBusy(false);
    }
  };
  const choices = replies.filter((reply) => reply.deletedAt === null);
  const selected = kept?.acceptedAnswer;
  return (
    <section
      className="mx-2 mt-3 flex flex-col gap-3 rounded-lg border-hairline border-border-subtle bg-surface-050 p-3"
      aria-label={t('knowledge.title')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-label font-semibold text-ink">{t('knowledge.title')}</h3>
        {member && draft === null && (
          <Button ref={editButton} variant="ghost" onClick={start}>
            {t('knowledge.edit')}
          </Button>
        )}
      </div>
      {selected != null && (
        <div className="flex flex-col gap-1">
          <span className="text-caption font-semibold text-success-text">
            {t('knowledge.accepted')}
          </span>
          <div className="line-clamp-4 break-words text-body text-ink">
            {renderContent(selected.content)}
          </div>
          <button
            type="button"
            className="w-fit text-label text-accent-text hover:underline"
            onClick={() => {
              navigate(messageHref(workspace.slug, root.channelId, selected.id));
            }}
          >
            {t('knowledge.source')}
          </button>
        </div>
      )}
      {kept?.decisionNote !== undefined && kept.decisionNote !== '' && (
        <p className="whitespace-pre-wrap break-words text-body text-ink">{kept.decisionNote}</p>
      )}
      {kept?.decisionUrl != null && (
        <a
          href={kept.decisionUrl}
          target="_blank"
          rel="noreferrer"
          className="break-all text-label text-accent-text hover:underline"
        >
          {t('knowledge.reference')}
        </a>
      )}
      {draft === null && selected == null && !kept?.decisionNote && (
        <p className="text-caption text-ink-muted">{t('knowledge.hint')}</p>
      )}
      {draft !== null && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="flex items-start gap-2 text-body text-ink">
            <Checkbox
              disabled={busy}
              checked={draft.isQuestion}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  isQuestion: event.target.checked,
                  assigneeId: event.target.checked ? draft.assigneeId : null,
                });
              }}
            />
            {t('knowledge.question')}
          </label>
          {draft.isQuestion && (
            <div className="flex flex-col gap-1 text-label text-ink">
              <label htmlFor={`${field}-owner`}>{t('knowledge.owner')}</label>
              <Select
                id={`${field}-owner`}
                value={draft.assigneeId ?? ''}
                disabled={busy || members.isPending || members.isError}
                onChange={(event) => {
                  setDraft({ ...draft, assigneeId: event.target.value || null });
                }}
              >
                <option value="">{t('knowledge.unassigned')}</option>
                {(members.data ?? []).map((person) => (
                  <option key={person.user.id} value={person.user.id}>
                    {person.user.displayName}
                  </option>
                ))}
              </Select>
              {members.isError && (
                <button
                  type="button"
                  onClick={() => {
                    void members.refetch();
                  }}
                  className="text-accent-text"
                >
                  {t('common.retry')}
                </button>
              )}
            </div>
          )}
          <label className="flex flex-col gap-1 text-label text-ink">
            {t('knowledge.answer')}
            <Select
              disabled={busy}
              value={draft.acceptedAnswerId ?? ''}
              onChange={(event) => {
                setDraft({ ...draft, acceptedAnswerId: event.target.value || null });
              }}
            >
              <option value="">{t('knowledge.noAnswer')}</option>
              {selected != null && !choices.some((reply) => reply.id === selected.id) && (
                <option value={selected.id}>{selected.content.slice(0, 100)}</option>
              )}
              {choices.map((reply) => (
                <option key={reply.id} value={reply.id}>
                  {reply.content.slice(0, 100) || t('knowledge.fileAnswer')}
                </option>
              ))}
            </Select>
          </label>
          <label htmlFor={field} className="text-label text-ink">
            {t('knowledge.note')}
          </label>
          <textarea
            disabled={busy}
            id={field}
            rows={4}
            maxLength={DECISION_NOTE_MAX}
            value={draft.decisionNote}
            className="w-full resize-y rounded-md border-hairline border-border-strong bg-surface-100 px-3 py-2 text-body text-ink"
            onChange={(event) => {
              setDraft({ ...draft, decisionNote: event.target.value });
            }}
          />
          <TextField
            disabled={busy}
            label={t('knowledge.reference')}
            type="url"
            value={draft.decisionUrl ?? ''}
            onChange={(event) => {
              setDraft({ ...draft, decisionUrl: event.target.value || null });
            }}
          />
          {error !== '' && (
            <p role="alert" className="text-label text-danger-text">
              {error}
            </p>
          )}
          {error !== '' && (kept?.version ?? 0) !== draft.version && (
            <Button
              variant="secondary"
              onClick={() => {
                setDraft({ ...draft, version: kept?.version ?? 0 });
                setError('');
              }}
            >
              {t('knowledge.reviewed')}
            </Button>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" busy={busy}>
              {t('knowledge.save')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
};
