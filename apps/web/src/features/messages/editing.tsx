/**
 * Editing one's own message (D-103, `UX.md` §5 and §7): the editor drawn in the row in place of
 * the words, and the menu that offers it.
 *
 * Which message is being edited is one fact for the channel screen, so the menu, `E` and `↑` open
 * the same editor; a row drawn outside a channel screen edits nothing.
 */
import { createContext, useContext, useMemo, useRef, useState } from 'react';
import type { QueryClient, InfiniteData } from '@tanstack/react-query';
import type { Message, MessagePage } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useActions } from '../../data/actions-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Menu, MenuItem } from '../../ui/menu';
import { useToast } from '../../ui/toast';

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
    .filter((m) => m.sender.id === meId && m.deletedAt === null)
    .reduce<Message | undefined>(
      (newest, m) => (newest === undefined || m.id > newest.id ? m : newest),
      undefined,
    );

/** The row's words, as a text box: Enter saves, Shift+Enter is a new line, Esc lets go. */
export const MessageEditor = ({ message }: { readonly message: Message }): React.JSX.Element => {
  const { t } = useI18n();
  const { edit } = useActions();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const { initial, start, stop } = useEditing();
  const [draft, setDraft] = useState(initial ?? message.content);
  const placed = useRef(false);

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
          if (box === null || placed.current) return;
          placed.current = true;
          box.focus();
          box.setSelectionRange(box.value.length, box.value.length);
        }}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            // Esc closes the topmost thing (`UX.md` §7): this, and nothing behind it.
            event.preventDefault();
            event.stopPropagation();
            stop();
          } else if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            save();
          }
        }}
        rows={Math.min(8, draft.split('\n').length + 1)}
        className="w-full resize-none rounded-md border-hairline border-border-strong bg-surface-100 px-2 py-1 text-body text-ink"
      />
      <div className="flex items-center justify-between gap-2 text-caption text-ink-muted">
        <span>{t('message.editHint')}</span>
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

/** What the author can do with their own message: edit it. */
export const OwnActions = ({ message }: { readonly message: Message }): React.JSX.Element => {
  const { t } = useI18n();
  const { start } = useEditing();
  // Edit puts focus in the editor it opens; the menu must not take it back to its button.
  const toEditor = useRef(false);

  return (
    <Menu
      align="end"
      returnFocus={() => {
        if (!toEditor.current) return true;
        toEditor.current = false;
        // The open menu trapped focus from the editor that mounted under it: given it as it closes.
        document
          .querySelector<HTMLTextAreaElement>(`[data-message-id="${message.id}"] textarea`)
          ?.focus();
        return false;
      }}
      trigger={
        <button
          type="button"
          aria-label={t('message.more')}
          className="inline-flex h-control aspect-square items-center justify-center rounded-sm text-ink-muted hover:bg-surface-100 hover:text-ink"
        >
          <Icon name="more" />
        </button>
      }
    >
      <MenuItem
        glyph="edit"
        shortcut="E"
        onSelect={() => {
          toEditor.current = true;
          start(message.id);
        }}
      >
        {t('message.edit')}
      </MenuItem>
    </Menu>
  );
};
