/**
 * The composer: one rounded card at the foot of the channel (`UX.md` §2, D-100).
 *
 * Plain text in a plain textarea, and a send button on the card's right edge. What it adds is what a person who types all day
 * needs and nothing a toolbar would: Enter sends and Shift+Enter does not; a fence
 * opened with ``` keeps Enter as a newline until it is closed, and Cmd/Ctrl+Enter sends
 * from inside it; a long paste becomes a code block with an Undo; the draft is
 * remembered per channel and per thread.
 *
 * **It never waits for the network and is never disabled by it.** Sending hands the text
 * to the realtime engine, which paints the row as `sending` before anything leaves and
 * falls back to HTTP if the socket is down (`ARCHITECTURE.md` §5.3). A person on a bad
 * connection can still write, and what they wrote is shown the moment they send it — the
 * failure, if there is one, belongs to the row, with a Retry.
 *
 * **The server is the authority; this refuses first, in words.** `@here` and its
 * siblings, a character the contract refuses and a message over the limit would each
 * come back as a 400 (D-99 §3, D-67). The same checks run here so the person is told
 * what to change without a round trip, in the language they read.
 *
 * **`@` and a letter offer people** (`UX.md` §5): a list of who a mention here would reach, found
 * by name or handle, that writes `@handle` into the box. While it is open the arrows, Enter, Tab and
 * Esc are the list's — Enter chooses and never sends. The box stays a text box and the list is
 * named by `aria-controls` and `aria-activedescendant` on it, not a `combobox` role a `textarea` may
 * not carry (D-110 §8).
 *
 * It is keyed by where it writes (`draftKey`), so a channel switch is a fresh composer
 * with that place's draft and the old one's is saved as it goes.
 */
import { Value } from '@sinclair/typebox/value';
import { MessageContent } from '@purlay/types';
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type GlyphName } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { useEngine } from '../../realtime/realtime-provider';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '../session/session';
import { lastOwnMessage, useEditing } from '../messages/editing';
import { Avatar } from '../../ui/avatar';
import { cn } from '../../ui/cn';
import { IconButton } from '../../ui/icon-button';
import { Kbd } from '../../ui/kbd';
import { useToast } from '../../ui/toast';
import { VisuallyHidden } from '../../ui/visually-hidden';
import {
  broadcastMention,
  continueList,
  enterAction,
  formatKey,
  insertMarkdown,
  insertText,
  insideFence,
  isLongPaste,
  asCodeBlock,
  rowsFor,
  trimEnd,
  typedWrap,
  unitsLeft,
  unitsOver,
  type MarkdownKind,
  type Selection,
} from './composer-text';
import { browserPorts, ComposerPortsContext, type ComposerPorts } from './composer-ports';
import { isMacPlatform, keyLabels } from '../shortcuts/platform';
import { useClientStorage } from '../../data/storage-provider';
import { isClaimedBy } from '../../data/browser-storage';
import { draftKey, readDraft, writeDraft } from './drafts';
import { useMentionCandidates } from './mention-candidates';
import { insertMention, mentionQuery, suggest } from './mention-suggest';
import { renderContent } from '../content/render-content';
import { duringComposition, useComposition } from './composition';
import { EmojiPicker } from './emoji-picker';
import { TypingLine } from './typing-line';
import { UploadList, useUploads } from './uploads';

export interface ComposerProps {
  readonly channelId: string;
  /** The channel's name as the person knows it ("api", a person's name for a DM). */
  readonly channelName: string;
  /** Makes what is sent a reply to this root; the thread's own composer passes it. */
  readonly parentId?: string;
  /** Takes focus when it mounts: a channel opens ready to write, a thread's box does not. */
  readonly autoFocus?: boolean;
  /** Called with the id of every message the person sends, as it is sent. */
  readonly onSent?: (id: string) => void;
}

/** How long after the last keystroke the draft is written: often enough to lose nothing, rarely enough to cost nothing. */
export const DRAFT_DEBOUNCE_MS = 300;

const Inner = ({
  channelId,
  channelName,
  parentId,
  autoFocus = false,
  onSent,
  ports,
}: ComposerProps & { readonly ports: ComposerPorts }): React.JSX.Element => {
  const { t } = useI18n();
  const engine = useEngine();
  const toast = useToast();
  const client = useQueryClient();
  const session = useSession();
  const key = draftKey(session.user.id, channelId, parentId);
  const editing = useEditing();
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => readDraft(ports.storage, key));
  const [error, setError] = useState<string | null>(null);
  // Whether focus is anywhere in the card: the hints are drawn only then, and are read always.
  const [focused, setFocused] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  // The draft drawn as it will be sent (D-181): a look, never a second copy of the text.
  const [previewing, setPreviewing] = useState(false);
  const returningFromPreview = useRef(false);
  // The formatting row is one Tab stop and the arrows move along it (the toolbar pattern): which
  // button is the stop, the last one used.
  const [stopAt, setStopAt] = useState(0);
  useEffect(() => {
    if (previewing || !returningFromPreview.current) return;
    returningFromPreview.current = false;
    field.current?.focus();
  }, [previewing]);
  const hintsId = useId();
  // Where the caret goes after a change that is made by script (a paste, an undo).
  const caret = useRef<number | null>(null);
  const composing = useComposition(field);
  const latest = useRef(text);
  latest.current = text;
  // Held above the composer, per place, with a send asked for while they were still uploading: a
  // channel switch or a closed thread loses neither, and the send still goes when they land (D-171).
  const uploads = useUploads(key, () => latest.current);
  const waiting = uploads.waiting;
  const setWaiting = (wanted: boolean): void => {
    uploads.wait(
      wanted
        ? { channelId, parentId, channelName, content: latest.current, storage: ports.storage }
        : null,
    );
  };
  // Where the caret is, for the `@` list: it reads what was typed up to here.
  const [caretAt, setCaretAt] = useState(text.length);
  // The `@` whose list Esc closed; it stays closed until a mention starts somewhere else.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();
  const candidates = useMentionCandidates(channelId);
  const { refresh: refreshCandidates } = candidates;

  const userId = session.user.id;
  // Debounced: written a moment after typing stops — while the page is still this person's.
  useEffect(() => {
    const cancel = ports.schedule(() => {
      if (isClaimedBy(ports.storage, userId)) writeDraft(ports.storage, key, text);
    }, DRAFT_DEBOUNCE_MS);
    return cancel;
  }, [text, key, ports, userId]);

  // Written for certain as the composer goes — a channel switch or a closed screen —
  // so the last keystrokes are never inside a timer that never fires. Not after a sign-out, or
  // after somebody else signed in in another tab: that would put the words back for them (#694).
  useEffect(
    () => (): void => {
      if (isClaimedBy(ports.storage, userId)) writeDraft(ports.storage, key, latest.current);
    },
    [key, ports, userId],
  );

  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (caret.current !== null) {
      field.current?.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [text]);

  const change = (next: string): void => {
    setText(next);
    // A new letter is a new list, and its best match is the one Enter takes.
    setActive(0);
    // Rationed by the engine; an emptied box says nothing, and the announcement runs out (D-114).
    // Not from a reply box: what is typed there never arrives in the channel's feed (`UX.md` §5).
    if (parentId === undefined && next.trim() !== '') engine.announceTyping(channelId);
    // What was wrong with the old text is not known to be wrong with the new.
    setError(null);
  };

  /** Where the caret goes once the text a button inserted is in the box. */
  const inserted = useRef<Selection | null>(null);
  useLayoutEffect(() => {
    const box = field.current;
    const wanted = inserted.current;
    if (box === null || wanted === null) return;
    inserted.current = null;
    box.focus();
    box.setSelectionRange(wanted.start, wanted.end);
  }, [text]);

  /** One of the three buttons: markdown inserted at the caret, as a key would type it (D-110). */
  const insert = (kind: MarkdownKind): void => {
    const box = field.current;
    const at = box === null ? text.length : box.selectionStart;
    const to = box === null ? text.length : box.selectionEnd;
    const next = insertMarkdown(text, { start: at, end: to }, kind);
    inserted.current = next.selection;
    change(next.text);
  };

  /** An emoji from the picker: text where the caret is, as a key would type it. */
  const insertEmoji = (emoji: string): void => {
    const box = field.current;
    const at = box === null ? text.length : box.selectionStart;
    const to = box === null ? text.length : box.selectionEnd;
    const next = insertText(text, { start: at, end: to }, emoji);
    inserted.current = next.selection;
    change(next.text);
  };

  // The list is drawn only while the box has focus: a person who has moved on is not asked.
  const mention = focused ? mentionQuery(text, caretAt) : null;
  const asking = mention !== null && mention.start !== dismissedAt;
  const suggestions = asking ? suggest(candidates.people, mention.query) : [];
  const open = suggestions.length > 0;
  // A private channel's members not read yet, or not readable: said, without a list to take Enter.
  const unknown = asking && candidates.state !== 'ready' ? candidates.state : null;
  // Each new `@` reads the channel's members again if they are stale: they change without a frame.
  const mentionStart = mention?.start ?? null;
  useEffect(() => {
    if (mentionStart !== null) refreshCandidates();
  }, [mentionStart, refreshCandidates]);
  const current = Math.min(active, suggestions.length - 1);
  const optionId = (index: number): string => `${listId}-option-${String(index)}`;

  /** Somebody chosen from the list: their handle replaces what was typed after the `@`. */
  const choose = (username: string): void => {
    if (mention === null) return;
    const next = insertMention(text, mention, username);
    inserted.current = { start: next.caret, end: next.caret };
    setCaretAt(next.caret);
    change(next.text);
  };

  const send = (): void => {
    const content = trimEnd(text);
    if (content === '' && uploads.items.length === 0) return;
    // A file that did not upload is the person's to retry or remove: nothing goes without it.
    if (uploads.items.some((item) => item.status === 'failed' || item.status === 'too-large')) {
      setWaiting(false);
      setError(t('composer.uploadFailed'));
      return;
    }
    const over = unitsOver(content);
    if (over > 0) {
      setError(t('composer.tooLong', { count: over }));
      return;
    }
    if (content !== '' && !Value.Check(MessageContent, content)) {
      setError(t('composer.invalid'));
      return;
    }
    const mention = broadcastMention(content);
    if (mention !== null) {
      setError(t('composer.broadcast', { mention }));
      return;
    }
    // Still uploading: it goes when they land, and says so meanwhile (`UX.md` §5).
    if (uploads.items.some((item) => item.status === 'uploading')) {
      setWaiting(true);
      setError(null);
      return;
    }
    const id = engine.send({
      channelId,
      content,
      ...(parentId === undefined ? {} : { parentId }),
      attachments: uploads.items.flatMap((item) =>
        item.status === 'ready' ? [item.attachment] : [],
      ),
    });
    uploads.clear();
    setWaiting(false);
    setText('');
    setError(null);
    // Gone from storage now, not a debounce from now: a reload right after sending must
    // not bring back what was sent.
    writeDraft(ports.storage, key, '');
    field.current?.focus();
    onSent?.(id);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      event.key === 'ArrowUp' &&
      parentId === undefined &&
      event.currentTarget.value === '' &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      // `↑` on an empty composer edits the last message of one's own (`UX.md` §5).
      const last = lastOwnMessage(client, channelId, session.user.id);
      if (last !== undefined) {
        event.preventDefault();
        editing.start(last.id);
        return;
      }
    }
    // A key that ends an IME composition (a Japanese or Chinese candidate) is not the
    // person pressing Enter: the event says so itself, an engine that reports `Process`
    // says so with the key, and one that fires `compositionend` first (Safari) is covered
    // by the flag the composition events keep.
    if (duringComposition(event, composing)) return;
    if (open && mention !== null) {
      const plain = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((current + step + suggestions.length) % suggestions.length);
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && plain) {
        // Chooses, and never sends: the message is not finished while a name is being picked.
        event.preventDefault();
        const chosen = suggestions[current];
        if (chosen !== undefined) choose(chosen.username);
        return;
      }
      if (event.key === 'Escape') {
        // Closes the list and nothing else: the text stays, the focus stays, the thread stays open.
        event.preventDefault();
        event.stopPropagation();
        setDismissedAt(mention.start);
        return;
      }
    }
    // A formatting key does what its button does (`formatKey`, D-181): one answer, shared.
    const asked = formatKey(event);
    if (asked !== null) {
      event.preventDefault();
      if (asked === 'preview') togglePreview();
      else insert(asked);
      return;
    }
    if (event.key === 'Escape') {
      event.currentTarget.blur();
      return;
    }
    const box = event.currentTarget;
    const wrapped = typedWrap(event, { start: box.selectionStart, end: box.selectionEnd });
    if (wrapped !== null) {
      event.preventDefault();
      insert(wrapped);
      return;
    }
    const action = enterAction(
      event,
      box.value.slice(0, box.selectionStart),
      ports.touchOnly?.() ?? false,
    );
    if (action === null) return;
    if (action === 'submit') {
      event.preventDefault();
      send();
      return;
    }
    // A new line. In a list or a quote it carries the marker on, and an empty item ends the list;
    // elsewhere — and inside a fence — the browser's own line break is right (D-181, D-188).
    if (!event.metaKey && !event.ctrlKey && box.selectionStart === box.selectionEnd) {
      const carried = continueList(box.value, box.selectionStart);
      if (carried !== null) {
        event.preventDefault();
        caret.current = carried.caret;
        change(carried.text);
      }
    }
  };

  // A send that was waiting goes once nothing is uploading; if something failed meanwhile, it says so.
  const uploading = uploads.items.some((item) => item.status === 'uploading');
  useEffect(() => {
    // `send` reads this render's words and files; it is called when what it waits on changes.
    if (waiting && !uploading) send();
  }, [waiting, uploading]);

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    // A pasted image or file is uploaded, not written into the box.
    const files = Array.from((event.clipboardData as DataTransfer | undefined)?.files ?? []);
    if (files.length > 0) {
      event.preventDefault();
      uploads.add(files);
      return;
    }
    // A paste with no clipboard data (some automation, some old engines) is just a paste.
    const pasted = (event.clipboardData as DataTransfer | undefined)?.getData('text/plain') ?? '';
    if (!isLongPaste(pasted)) return;
    event.preventDefault();
    const target = event.currentTarget;
    const before = text;
    const start = target.selectionStart;
    const block = asCodeBlock(pasted);
    caret.current = start + block.length;
    change(text.slice(0, start) + block + text.slice(target.selectionEnd));
    toast.show({
      message: t('composer.pasted'),
      actionLabel: t('common.undo'),
      onAction: () => {
        caret.current = start;
        change(before);
        field.current?.focus();
      },
    });
  };

  // The key printed in a tooltip: only the words depend on the platform, never the behaviour.
  const mac = isMacPlatform(typeof navigator === 'undefined' ? {} : navigator);
  const labels = keyLabels(mac);
  const chord = (...parts: readonly string[]): string => parts.join(mac ? '' : '+');
  /** One button of the formatting row: its markdown, its glyph and the key that does the same. */
  const tool = (
    slot: number,
    kind: MarkdownKind,
    label: string,
    glyph: GlyphName,
    shortcut?: string,
  ): React.JSX.Element => (
    <IconButton
      key={kind}
      label={label}
      glyph={glyph}
      {...(shortcut === undefined ? {} : { shortcut })}
      tabIndex={slot === stopAt ? 0 : -1}
      onFocus={() => {
        setStopAt(slot);
      }}
      onClick={() => {
        insert(kind);
      }}
    />
  );
  /** ← → Home End along the row, round at its ends; Tab is left to leave it. */
  const onToolbarKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
    const at = buttons.findIndex((button) => button === document.activeElement);
    const to =
      event.key === 'ArrowRight'
        ? (at + 1) % buttons.length
        : event.key === 'ArrowLeft'
          ? (at - 1 + buttons.length) % buttons.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : -1;
    if (at === -1 || to === -1) return;
    event.preventDefault();
    buttons[to]?.focus();
  };
  /** Preview on or off; back on the text, the box has the focus again where it left it. */
  const togglePreview = (): void => {
    setPreviewing((now) => !now);
    returningFromPreview.current = previewing;
  };
  const divider = (
    <span aria-hidden="true" className="mx-1 h-4 border-l-hairline border-border-subtle" />
  );

  const left = unitsLeft(text);
  const rows = rowsFor(text, 1);

  const compact = parentId !== undefined;
  const empty = trimEnd(text) === '';
  // Inside an open fence, and on a phone, Enter is a new line, so the key that sends is the one the hint
  // names (D-188) — and the field's description, which a screen reader reads at every width, says it too.
  const fenced = insideFence(text.slice(0, caretAt)) || (ports.touchOnly?.() ?? false);
  const hints = (
    <>
      <span className="whitespace-nowrap">
        <Kbd>{fenced ? chord(labels.mod, labels.enter) : 'Enter'}</Kbd> {t('composer.hint.send')}
      </span>
      <span className="whitespace-nowrap">
        <Kbd>Shift+Enter</Kbd> {t('composer.hint.newline')}
      </span>
      <span className="whitespace-nowrap">
        <Kbd>```</Kbd> {t('composer.hint.code')}
      </span>
    </>
  );
  // A thread's panel is too narrow for them beside the buttons (`size-thread`): read, not drawn (D-164).
  const hintsBlock =
    focused && !compact ? (
      // Each hint whole. Not drawn on a narrow window: a phone's keyboard has no Shift+Enter, and drawn
      // there they took a row of their own, so focusing the composer made it taller and moved what was
      // above it — a pill moved between a press and its release, and the click missed (#654). They are
      // still the field's description, which a screen reader reads.
      <span
        id={hintsId}
        className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-caption text-ink-muted max-narrow:hidden"
      >
        {hints}
      </span>
    ) : (
      <VisuallyHidden>
        <span id={hintsId}>{hints}</span>
      </VisuallyHidden>
    );
  const counter = (
    <span aria-live="polite" className="ml-auto text-caption text-ink-muted">
      {left === null
        ? null
        : left >= 0
          ? t('composer.remaining', { count: left })
          : t('composer.tooLong', { count: -left })}
    </span>
  );
  const sendButton = (
    <button
      type="button"
      onClick={send}
      aria-disabled={empty && uploads.items.length === 0}
      aria-label={t('composer.send')}
      className={cn(
        'inline-flex h-control shrink-0 items-center justify-center gap-2 rounded-md bg-accent text-label font-medium text-on-accent transition-colors duration-hover ease-standard hover:bg-accent-hover aria-disabled:cursor-not-allowed aria-disabled:bg-surface-200 aria-disabled:text-ink-muted max-narrow:h-touch',
        compact ? 'aspect-square' : 'px-3',
      )}
    >
      <Icon name="send" size="sm" />
      {!compact && (
        <>
          <span aria-hidden="true" className="h-4 border-l-hairline border-current" />
          <span aria-hidden="true" className="font-mono text-caption">
            ↵
          </span>
        </>
      )}
    </button>
  );

  return (
    <div className="shrink-0 pb-4 pt-2">
      <div className="flex w-full flex-col gap-2 px-6 max-narrow:px-4">
        <div
          data-composer-card=""
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) event.preventDefault();
          }}
          onDrop={(event) => {
            if (event.dataTransfer.files.length === 0) return;
            event.preventDefault();
            uploads.add(Array.from(event.dataTransfer.files));
          }}
          onFocus={() => {
            setFocused(true);
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
          }}
          className={cn(
            'relative flex flex-col rounded-2xl border-hairline border-border-subtle bg-surface-100 shadow-raised transition-colors duration-hover ease-standard',
            // Drawn inward, over the card's own edge: outside it, the gap reads as a second border.
            focused && 'outline-focus outline-focus-ring -outline-offset-focus',
          )}
        >
          {unknown !== null && (
            <div
              role="status"
              aria-label={t(unknown === 'failed' ? 'mention.unreadable' : 'mention.reading')}
              // Retry must not take focus from the box.
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              className="absolute bottom-full left-0 z-popover mb-2 flex w-full max-w-dialog items-center gap-2 rounded-2xl border-hairline border-border-subtle bg-surface-100 px-4 py-2 text-label text-ink-muted shadow-float"
            >
              {t(unknown === 'failed' ? 'mention.unreadable' : 'mention.reading')}
              {unknown === 'failed' && (
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    refreshCandidates();
                  }}
                >
                  {t('common.retry')}
                </button>
              )}
            </div>
          )}
          {open && (
            <div className="absolute bottom-full left-0 z-popover mb-2 w-full max-w-dialog overflow-hidden rounded-2xl border-hairline border-border-subtle bg-surface-100 shadow-float">
              <div
                id={listId}
                role="listbox"
                aria-label={t('mention.listLabel')}
                // Choosing with the mouse must not take focus from the box: typing goes on there.
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                className="max-h-palette-list overflow-y-auto p-1"
              >
                {suggestions.map((person, index) => (
                  <div
                    key={person.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === current}
                    onClick={() => {
                      choose(person.username);
                    }}
                    onPointerMove={() => {
                      if (index !== current) setActive(index);
                    }}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2',
                      index === current && 'bg-accent-subtle',
                    )}
                  >
                    <Avatar size="sm" name={person.displayName} username={person.username} />
                    <span className="min-w-0 truncate text-body font-medium text-ink">
                      {person.displayName}
                    </span>
                    <span className="shrink-0 font-mono text-caption text-ink-muted">
                      @{person.username}
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex gap-4 border-t-hairline border-border-subtle px-4 py-2 text-caption text-ink-muted">
                <span>
                  <Kbd>↑</Kbd> <Kbd>↓</Kbd> {t('mention.hint.move')}
                </span>
                <span>
                  <Kbd>Enter</Kbd> {t('mention.hint.insert')}
                </span>
                <span>
                  <Kbd>Esc</Kbd> {t('mention.hint.close')}
                </span>
              </div>
            </div>
          )}
          <VisuallyHidden role="status" aria-live="polite">
            {open ? t('mention.results', { count: suggestions.length }) : ''}
          </VisuallyHidden>
          <div
            role="toolbar"
            aria-label={t('composer.format')}
            aria-orientation="horizontal"
            className="flex items-center px-2 pt-2"
            onKeyDown={onToolbarKey}
          >
            {/* One row on every width: on a phone it scrolls sideways instead of breaking into two, and
              the preview toggle stays where it is. */}
            <div className="flex min-w-0 flex-1 items-center overflow-x-auto p-1 scrollbar-thin">
              {tool(0, 'bold', t('composer.bold'), 'bold', chord(labels.mod, 'B'))}
              {tool(1, 'italic', t('composer.italic'), 'italic', chord(labels.mod, 'I'))}
              {tool(
                2,
                'strike',
                t('composer.strike'),
                'strike',
                chord(labels.mod, labels.shift, 'X'),
              )}
              {divider}
              {tool(3, 'link', t('composer.link'), 'link', chord(labels.mod, labels.shift, 'U'))}
              {tool(
                4,
                'bullets',
                t('composer.bullets'),
                'bullet-list',
                chord(labels.mod, labels.shift, '8'),
              )}
              {tool(
                5,
                'numbers',
                t('composer.numbers'),
                'numbered-list',
                chord(labels.mod, labels.shift, '7'),
              )}
              {tool(6, 'quote', t('composer.quote'), 'quote', chord(labels.mod, labels.shift, '9'))}
              {divider}
              {tool(
                7,
                'inlineCode',
                t('composer.inlineCode'),
                'inline-code',
                chord(labels.mod, 'E'),
              )}
              {tool(
                8,
                'code',
                t('composer.codeBlock'),
                'code-block',
                chord(labels.mod, labels.alt, labels.shift, 'C'),
              )}
            </div>
            <IconButton
              label={t('composer.preview')}
              glyph="preview"
              shortcut={chord(labels.mod, labels.shift, 'P')}
              aria-pressed={previewing}
              tabIndex={stopAt === 9 ? 0 : -1}
              onFocus={() => {
                setStopAt(9);
              }}
              className="ml-1 aria-pressed:bg-surface-200 aria-pressed:text-accent-text"
              onClick={togglePreview}
            />
          </div>
          <div className="flex gap-2 px-3 pt-2">
            <textarea
              data-composer=""
              ref={field}
              rows={rows}
              value={text}
              aria-label={t('composer.label', { channel: channelName })}
              aria-invalid={error === null ? undefined : true}
              aria-describedby={hintsId}
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-controls={open ? listId : undefined}
              aria-activedescendant={open ? optionId(current) : undefined}
              placeholder={t('composer.placeholder', { channel: channelName })}
              hidden={previewing}
              className="min-w-0 flex-1 resize-none bg-transparent text-body text-ink outline-none placeholder:text-ink-muted"
              onChange={(event) => {
                const { value, selectionStart } = event.target;
                change(value);
                setCaretAt(selectionStart);
                // The `@` that was dismissed is gone: the next one opens again.
                if (mentionQuery(value, selectionStart) === null) setDismissedAt(null);
              }}
              onSelect={(event) => {
                setCaretAt(event.currentTarget.selectionStart);
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
            {previewing && (
              <div data-composer-preview="" className="min-h-control min-w-0 flex-1">
                {empty ? (
                  <p className="text-body text-ink-muted">{t('composer.previewEmpty')}</p>
                ) : (
                  renderContent(text)
                )}
              </div>
            )}
          </div>
          <UploadList uploads={uploads} />
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            aria-label={t('composer.attach')}
            onChange={(event) => {
              uploads.add(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
          {/* The same buttons in a thread as in the channel (D-164): a reply is a message like any other. */}
          <div className="flex items-center gap-3 pb-2 pl-2 pr-2 pt-1">
            <span className="flex items-center gap-1">
              <IconButton
                label={t('composer.mention')}
                glyph="mention"
                onClick={() => {
                  insert('mention');
                }}
              />
              <EmojiPicker
                onPick={insertEmoji}
                onClosed={() => {
                  field.current?.focus();
                }}
              />
              <IconButton
                label={t('composer.attach')}
                glyph="attach"
                onClick={() => {
                  picker.current?.click();
                }}
              />
              {/* Between the buttons and the hints, and only where the hints are drawn: unfocused, in a
                  thread, or on a phone it divided the buttons from nothing. */}
              {focused && !compact && (
                <span
                  aria-hidden="true"
                  data-hints-divider=""
                  className="mx-1 h-4 border-l-hairline border-border-subtle max-narrow:hidden"
                />
              )}
            </span>
            {hintsBlock}
            {!compact && <TypingLine channelId={channelId} />}
            {counter}
            {sendButton}
          </div>
        </div>
        {waiting && (
          <p role="status" className="flex items-center gap-2 px-1 text-label text-ink-muted">
            <Icon name="sending" size="sm" />
            {t('composer.waiting')}
          </p>
        )}
        {error !== null && (
          <p role="alert" className="flex items-center gap-2 px-1 text-label text-danger-text">
            <Icon name="failed" size="sm" />
            {error}
          </p>
        )}
      </div>
    </div>
  );
};

export const Composer = (props: ComposerProps): React.JSX.Element => {
  const given = useContext(ComposerPortsContext);
  // The page's own storage, the one sign-out and a change of person forget (#694) — not a second
  // look-up of the same `localStorage` that a test could not see forgotten.
  const storage = useClientStorage();
  // Resolved on first render, not at import: there is no window when the shell is prerendered.
  const [fallback] = useState(() => given ?? { ...browserPorts(), storage });
  const { user } = useSession();
  return (
    <Inner
      key={draftKey(user.id, props.channelId, props.parentId)}
      {...props}
      ports={given ?? fallback}
    />
  );
};
