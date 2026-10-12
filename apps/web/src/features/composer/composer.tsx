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
 * It is keyed by where it writes (`draftKey`), so a channel switch is a fresh composer
 * with that place's draft and the old one's is saved as it goes.
 */
import { Value } from '@sinclair/typebox/value';
import { MessageContent } from '@purlay/types';
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { useEngine } from '../../realtime/realtime-provider';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '../session/session';
import { lastOwnMessage, useEditing } from '../messages/editing';
import { cn } from '../../ui/cn';
import { IconButton } from '../../ui/icon-button';
import { Kbd } from '../../ui/kbd';
import { useToast } from '../../ui/toast';
import { VisuallyHidden } from '../../ui/visually-hidden';
import {
  broadcastMention,
  insertMarkdown,
  insideFence,
  isLongPaste,
  asCodeBlock,
  rowsFor,
  trimEnd,
  unitsLeft,
  unitsOver,
  type MarkdownKind,
  type Selection,
} from './composer-text';
import { browserPorts, ComposerPortsContext, type ComposerPorts } from './composer-ports';
import { draftKey, readDraft, writeDraft } from './drafts';
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
  const key = draftKey(channelId, parentId);
  const client = useQueryClient();
  const session = useSession();
  const editing = useEditing();
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => readDraft(ports.storage, key));
  const [error, setError] = useState<string | null>(null);
  // Whether focus is anywhere in the card: the hints are drawn only then, and are read always.
  const [focused, setFocused] = useState(false);
  const uploads = useUploads();
  // A send asked for while files were still uploading.
  const [waiting, setWaiting] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const hintsId = useId();
  // Where the caret goes after a change that is made by script (a paste, an undo).
  const caret = useRef<number | null>(null);
  const composing = useRef(false);
  const latest = useRef(text);
  latest.current = text;

  // Debounced: written a moment after typing stops.
  useEffect(() => {
    const cancel = ports.schedule(() => {
      writeDraft(ports.storage, key, text);
    }, DRAFT_DEBOUNCE_MS);
    return cancel;
  }, [text, key, ports]);

  // Written for certain as the composer goes — a channel switch or a closed screen —
  // so the last keystrokes are never inside a timer that never fires.
  useEffect(
    () => (): void => {
      writeDraft(ports.storage, key, latest.current);
    },
    [key, ports],
  );

  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  // Native listeners, not React props: React only wires composition events where the
  // engine advertises `CompositionEvent`, and the flag must not depend on that.
  useEffect(() => {
    const element = field.current;
    if (element === null) return undefined;
    const start = (): void => {
      composing.current = true;
    };
    const end = (): void => {
      // Safari fires the keydown that ends a composition *after* compositionend, so the
      // flag is cleared a turn later, once that key has been seen and ignored.
      window.setTimeout(() => {
        composing.current = false;
      }, 0);
    };
    element.addEventListener('compositionstart', start);
    element.addEventListener('compositionend', end);
    return (): void => {
      element.removeEventListener('compositionstart', start);
      element.removeEventListener('compositionend', end);
    };
  }, []);

  useEffect(() => {
    if (caret.current !== null) {
      field.current?.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [text]);

  const change = (next: string): void => {
    setText(next);
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
    if (event.nativeEvent.isComposing || event.key === 'Process' || composing.current) return;
    if (event.key === 'Escape') {
      event.currentTarget.blur();
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      send();
      return;
    }
    const before = event.currentTarget.value.slice(0, event.currentTarget.selectionStart);
    // Inside a fence Enter is a newline: the browser's own behaviour, left alone.
    if (insideFence(before)) return;
    event.preventDefault();
    send();
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

  const left = unitsLeft(text);
  const rows = rowsFor(text, 1);

  const compact = parentId !== undefined;
  const empty = trimEnd(text) === '';
  const hints = (
    <>
      <span>
        <Kbd>Enter</Kbd> {t('composer.hint.send')}
      </span>
      <span>
        <Kbd>Shift+Enter</Kbd> {t('composer.hint.newline')}
      </span>
      <span>
        <Kbd>```</Kbd> {t('composer.hint.code')}
      </span>
    </>
  );
  const hintsBlock = focused ? (
    <span id={hintsId} className="flex gap-3 text-caption text-ink-muted">
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
      aria-disabled={empty}
      aria-label={t('composer.send')}
      className="inline-flex size-control shrink-0 items-center justify-center rounded-lg bg-accent text-on-accent transition-colors duration-hover ease-standard hover:bg-accent-hover aria-disabled:cursor-not-allowed aria-disabled:bg-surface-200 aria-disabled:text-ink-muted max-narrow:size-touch"
    >
      <Icon name="send" />
    </button>
  );

  return (
    <div className="shrink-0 pb-4 pt-2">
      <div className="flex w-full max-w-feed flex-col gap-2 px-5">
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
            'flex flex-col rounded-2xl border-hairline border-border-subtle bg-surface-100 shadow-card transition-colors duration-hover ease-standard focus-within:border-border-strong',
            focused && 'outline-focus outline-focus-ring outline-offset-focus',
          )}
        >
          <div className={cn('flex gap-2 px-4', compact ? 'items-center py-2' : 'pt-3')}>
            <textarea
              data-composer=""
              ref={field}
              rows={rows}
              value={text}
              aria-label={t('composer.label', { channel: channelName })}
              aria-invalid={error === null ? undefined : true}
              aria-describedby={hintsId}
              placeholder={t('composer.placeholder', { channel: channelName })}
              className="min-w-0 flex-1 resize-none bg-transparent text-body text-ink outline-none placeholder:text-ink-muted"
              onChange={(event) => {
                change(event.target.value);
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
            {compact && sendButton}
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
          {compact && !focused && left === null ? (
            hintsBlock
          ) : (
            <div
              className={cn(
                'flex items-center gap-3 px-4',
                compact ? 'pb-2' : 'pb-2 pl-2 pr-2 pt-1',
              )}
            >
              {!compact && (
                <span className="flex items-center gap-1">
                  <IconButton
                    label={t('composer.bold')}
                    glyph="bold"
                    onClick={() => {
                      insert('bold');
                    }}
                  />
                  <IconButton
                    label={t('composer.codeBlock')}
                    glyph="code"
                    onClick={() => {
                      insert('code');
                    }}
                  />
                  <IconButton
                    label={t('composer.mention')}
                    glyph="mention"
                    onClick={() => {
                      insert('mention');
                    }}
                  />
                  <IconButton
                    label={t('composer.attach')}
                    glyph="attach"
                    onClick={() => {
                      picker.current?.click();
                    }}
                  />
                  <span
                    aria-hidden="true"
                    className="mx-1 h-4 border-l-hairline border-border-subtle"
                  />
                </span>
              )}
              {hintsBlock}
              {counter}
              {!compact && sendButton}
            </div>
          )}
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
  // Resolved on first render, not at import: there is no window when the shell is prerendered.
  const [fallback] = useState(() => given ?? browserPorts());
  return (
    <Inner key={draftKey(props.channelId, props.parentId)} {...props} ports={given ?? fallback} />
  );
};
