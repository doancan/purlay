/**
 * Editing one's own message (D-103, `UX.md` §5 and §7): the editor drawn in the row in place of the
 * words. The menu that offers it, and Delete, are the row's More (`message-actions.tsx`, D-150).
 *
 * Which message is being edited is one fact for the channel screen, so the menu, `E` and `↑` open
 * the same editor; a row drawn outside a channel screen edits nothing.
 */
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { QueryClient, InfiniteData } from '@tanstack/react-query';
import type { Message, MessagePage } from '@purlay/types';
import { useActions } from '../../data/actions-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { useToast } from '../../ui/toast';
import {
  continueList,
  enterAction,
  formatKey,
  insertMarkdown,
  insideFence,
  typedWrap,
  type Selection,
} from '../composer/composer-text';
import { ComposerPortsContext, isTouchOnly } from '../composer/composer-ports';
import { duringComposition, useComposition } from '../composer/composition';
import { isMacPlatform, keyLabels } from '../shortcuts/platform';
import { isMine } from './author';

interface Editing {
  readonly editingId: string | null;
  /** What the editor starts with: the message's words, or a draft an edit that failed left. */
  readonly initial: string | null;
  readonly start: (messageId: string, initial?: string) => void;
  readonly stop: () => void;
}

const ignored = (): void => undefined;
const NOTHING: Editing = { editingId: null, initial: null, start: ignored, stop: ignored };

const EditingContext = createContext<Editing>(NOTHING);

export const useEditing = (): Editing => useContext(EditingContext);

export const EditingProvider = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const [editing, setEditing] = useState<{ id: string; initial: string | null } | null>(null);
  const value = useMemo<Editing>(
    () => ({
      editingId: editing?.id ?? null,
      initial: editing?.initial ?? null,
      start: (id, initial): void => {
        setEditing({ id, initial: initial ?? null });
      },
      stop: (): void => {
        setEditing(null);
      },
    }),
    [editing],
  );
  return <EditingContext.Provider value={value}>{children}</EditingContext.Provider>;
};

/** The newest message of one's own in the channel that can still be edited: what `↑` opens. */
export const lastOwnMessage = (
  client: QueryClient,
  channelId: string,
  meId: string,
): Message | undefined =>
  client
    .getQueryData<InfiniteData<MessagePage>>(keys.messages(channelId))
    ?.pages.flatMap((page) => page.data)
    .filter((m) => isMine(m, meId) && m.deletedAt === null)
    .reduce<Message | undefined>(
      (newest, m) => (newest === undefined || m.id > newest.id ? m : newest),
      undefined,
    );

/**
 * The row's words, as a text box that takes the composer's keys (D-188): Enter saves — except inside an
 * open code fence, where it is a new line and Ctrl/Meta+Enter saves — Shift+Enter is a new line that
 * carries a list on, the formatting keys format, Esc lets go.
 */
export const MessageEditor = ({ message }: { readonly message: Message }): React.JSX.Element => {
  const { t } = useI18n();
  const { edit } = useActions();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const { initial, start, stop } = useEditing();
  const [draft, setDraft] = useState(initial ?? message.content);
  const placed = useRef(false);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const composing = useComposition(field);
  const touchOnly = useContext(ComposerPortsContext)?.touchOnly ?? isTouchOnly;
  const [caretAt, setCaretAt] = useState(draft.length);
  /** Where the caret goes once the text a key changed is in the box. */
  const wanted = useRef<Selection | null>(null);
  /** The text a key made, and where the caret goes in it: set now when the text is the same, else after it renders. */
  const put = (text: string, selection: Selection): void => {
    if (text === draft) {
      field.current?.setSelectionRange(selection.start, selection.end);
      return;
    }
    wanted.current = selection;
    setDraft(text);
  };
  useLayoutEffect(() => {
    const box = field.current;
    if (box === null || wanted.current === null) return;
    box.setSelectionRange(wanted.current.start, wanted.current.end);
    wanted.current = null;
  }, [draft]);

  // The key that saves: Enter, except where Enter is a new line — inside an open fence, or on a phone.
  const labels = keyLabels(isMacPlatform(typeof navigator === 'undefined' ? {} : navigator));
  const saveKey =
    touchOnly() || insideFence(draft.slice(0, caretAt))
      ? `${labels.mod}${labels.mod === 'Ctrl' ? '+' : ''}${labels.enter}`
      : 'Enter';

  const save = (): void => {
    const content = draft;
    stop();
    if (content === message.content || content.trim() === '') return;
    edit(message, content).catch((failure: unknown) => {
      show({ message: `${t('message.editFailed')} ${describe(failure)}` });
      start(message.id, content);
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <textarea
        aria-label={t('message.editLabel')}
        value={draft}
        // Focused once, caret after the words: not on every focus, which would undo a selection.
        ref={(box) => {
          field.current = box;
          if (box === null || placed.current) return;
          placed.current = true;
          box.focus();
          box.setSelectionRange(box.value.length, box.value.length);
        }}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setCaretAt(event.currentTarget.selectionStart);
        }}
        onSelect={(event) => {
          setCaretAt(event.currentTarget.selectionStart);
        }}
        onKeyDown={(event) => {
          if (duringComposition(event, composing)) return;
          const box = event.currentTarget;
          const selection = { start: box.selectionStart, end: box.selectionEnd };
          if (event.key === 'Escape') {
            // Esc closes the topmost thing (`UX.md` §7): this, and nothing behind it.
            event.preventDefault();
            event.stopPropagation();
            stop();
            return;
          }
          const asked = formatKey(event);
          const kind = asked === 'preview' ? null : (asked ?? typedWrap(event, selection));
          if (kind !== null) {
            event.preventDefault();
            const next = insertMarkdown(draft, selection, kind);
            put(next.text, next.selection);
            return;
          }
          const action = enterAction(event, box.value.slice(0, selection.start), touchOnly());
          if (action === 'submit') {
            event.preventDefault();
            save();
          } else if (action === 'newline' && !event.metaKey && !event.ctrlKey) {
            const carried =
              selection.start === selection.end ? continueList(box.value, selection.start) : null;
            if (carried !== null) {
              event.preventDefault();
              put(carried.text, { start: carried.caret, end: carried.caret });
            }
          }
        }}
        rows={Math.min(8, draft.split('\n').length + 1)}
        className="w-full resize-none rounded-md border-hairline border-border-strong bg-surface-100 px-2 py-1 text-body text-ink"
      />
      <div className="flex items-center justify-between gap-2 text-caption text-ink-muted">
        <span className="flex flex-col">
          <span>{t('message.editHint', { save: saveKey })}</span>
          <span>{t('message.editHistoryHint')}</span>
        </span>
        <span className="flex gap-2">
          <Button variant="ghost" onClick={stop}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={save}>
            {t('message.editSave')}
          </Button>
        </span>
      </div>
    </div>
  );
};
