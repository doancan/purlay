/**
 * The composer: a prompt line, not a card (`UX.md` §5, the approved prototype).
 *
 * Plain text in a plain textarea. What it adds is what a person who types all day
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
import { useContext, useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { useEngine } from '../../realtime/realtime-provider';
import { Button } from '../../ui/button';
import { Kbd } from '../../ui/kbd';
import { useToast } from '../../ui/toast';
import {
  broadcastMention,
  insideFence,
  isLongPaste,
  asCodeBlock,
  rowsFor,
  trimEnd,
  unitsLeft,
  unitsOver,
} from './composer-text';
import { browserPorts, ComposerPortsContext, type ComposerPorts } from './composer-ports';
import { draftKey, readDraft, writeDraft } from './drafts';

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
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => readDraft(ports.storage, key));
  const [error, setError] = useState<string | null>(null);
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

  const send = (): void => {
    const content = trimEnd(text);
    if (content === '') return;
    const over = unitsOver(content);
    if (over > 0) {
      setError(t('composer.tooLong', { count: over }));
      return;
    }
    if (!Value.Check(MessageContent, content)) {
      setError(t('composer.invalid'));
      return;
    }
    const mention = broadcastMention(content);
    if (mention !== null) {
      setError(t('composer.broadcast', { mention }));
      return;
    }
    const id = engine.send({ channelId, content, ...(parentId === undefined ? {} : { parentId }) });
    setText('');
    setError(null);
    // Gone from storage now, not a debounce from now: a reload right after sending must
    // not bring back what was sent.
    writeDraft(ports.storage, key, '');
    field.current?.focus();
    onSent?.(id);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
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

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
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
  const rows = rowsFor(text);

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t-hairline border-border-subtle px-4 py-3">
      <div className="flex max-w-feed items-start gap-3">
        <span
          aria-hidden="true"
          className="w-gutter shrink-0 truncate text-right font-mono text-body text-ink-muted"
        >
          {channelName} ›
        </span>
        <textarea
          ref={field}
          rows={rows}
          value={text}
          aria-label={t('composer.label', { channel: channelName })}
          aria-invalid={error === null ? undefined : true}
          placeholder={t('composer.placeholder', { channel: channelName })}
          className="min-w-0 flex-1 resize-none text-body text-ink placeholder:text-ink-muted"
          onChange={(event) => {
            change(event.target.value);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <Button variant="primary" onClick={send}>
          {t('composer.send')} <span aria-hidden="true">↵</span>
        </Button>
      </div>
      <div className="flex max-w-feed items-center gap-3 text-caption text-ink-muted">
        <span aria-hidden="true" className="w-gutter shrink-0" />
        <span>
          <Kbd>Enter</Kbd> {t('composer.hint.send')}
        </span>
        <span>
          <Kbd>Shift+Enter</Kbd> {t('composer.hint.newline')}
        </span>
        <span>
          <Kbd>```</Kbd> {t('composer.hint.code')}
        </span>
        <span aria-live="polite" className="flex-1 text-right">
          {left === null
            ? null
            : left >= 0
              ? t('composer.remaining', { count: left })
              : t('composer.tooLong', { count: -left })}
        </span>
      </div>
      {error !== null && (
        <div className="flex max-w-feed gap-3">
          <span aria-hidden="true" className="w-gutter shrink-0" />
          <p role="alert" className="flex items-center gap-2 text-label text-danger-text">
            <Icon name="failed" size="sm" />
            {error}
          </p>
        </div>
      )}
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
