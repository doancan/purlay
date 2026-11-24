/**
 * The composer: one rounded card at the foot of the channel (`UX.md` §2, D-100).
 *
 * Formatted editing by default, with a Markdown source toggle and a send button. Enter sends and Shift+Enter does not; a fence
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
import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { formattingRanges } from '@purlay/markdown';
import { Icon } from '../../../components/icon';
import { useI18n } from '../../../i18n/i18n-provider';
import { useEngine } from '../../../realtime/realtime-provider';
import { useQueryClient } from '@tanstack/react-query';
import { isApiError } from '../../../data/errors';
import { useRunsIfAny, useSession } from '../../session/session';
import { lastOwnMessage, useEditing } from '../messages/editing';
import { cn } from '../../../ui/cn';
import { IconButton } from '../../../ui/icon-button';
import { useToast } from '../../../ui/toast';
import { VisuallyHidden } from '../../../ui/visually-hidden';
import { celebrate, hasPartyPopper } from '../../../ui/celebrate';
import {
  broadcastMention,
  continueList,
  enterAction,
  formatKey,
  insertMarkdown,
  insertText,
  insideFence,
  rowsFor,
  trimEnd,
  typedWrap,
  unitsLeft,
  unitsOver,
  type MarkdownKind,
  type Selection,
} from './composer-text';
import { browserPorts, ComposerPortsContext, type ComposerPorts } from './composer-ports';
import { isMacPlatform, keyLabels } from '../../shortcuts/platform';
import { useClientStorage } from '../../../data/storage-provider';
import { draftKey, readDraft, useDraftWriter, writeDraft } from './drafts';
import { useMentionCandidates } from './mention-candidates';
import { shortcodeQuery } from './emoji-shortcodes';
import { useEmojiNames } from './use-emoji-names';
import { insertMention, mentionQuery, suggest } from './mention-suggest';
import { duringComposition, useComposition } from './composition';
import { FileOfferBar, useFileOffer } from './file-offer';
import { usePasteHandler } from './paste-handler';
import { composerKey, useComposerInbox } from './quote';
import { SLASH_COMMANDS, commandsFor, parseSlash, slashQuery, type SlashName } from './slash';
import { useSlashRunner } from './slash-run';
import {
  CommandList,
  MentionList,
  commandListId,
  commandOptionId,
  mentionListId,
  mentionOptionId,
  shortcodeListId,
  shortcodeOptionId,
} from './suggestion-lists';
import { EmojiPicker } from './emoji-picker';
import { FormatToolbar } from './format-toolbar';
import { activeFormatting } from './active-formatting';
import { insertLink } from './link-text';
import { useComposerSize } from './use-composer-size';
import { KeyHints } from './key-hints';
import { typedAfterFace, withClosingEmoji, type Emoticon } from './emoticons';
import { TypingLine } from './typing-line';
import { SendLater } from '../scheduled/send-later';
import { useScheduleMessage } from '../scheduled/use-schedule-message';
import { UploadList, useUploads } from './uploads';
import type { ComposerInput, ComposerKeyEvent } from './composer-input';
import type { RichInput } from './rich-editor';

const RichEditor = lazy(() =>
  import('./rich-editor').then((module) => ({ default: module.RichEditor })),
);
const LinkDialog = lazy(() =>
  import('./link-dialog').then((module) => ({ default: module.LinkDialog })),
);

const SOURCE_MODE_KEY = 'purlay.composerSource';
const readSourceMode = (storage: ComposerPorts['storage']): boolean => {
  try {
    return storage?.getItem(SOURCE_MODE_KEY) === 'true';
  } catch {
    return false;
  }
};

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
  const rawField = useRef<HTMLTextAreaElement>(null);
  const richField = useRef<RichInput | null>(null);
  const [richReady, setRichReady] = useState(false);
  const field = useRef<ComposerInput | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(() => readDraft(ports.storage, key));
  const [error, setError] = useState<string | null>(null);
  // Whether focus is anywhere in the card: the hints are drawn only then, and are read always.
  const [focused, setFocused] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [sourceMode, setSourceMode] = useState(
    () => readSourceMode(ports.storage) || unitsOver(text) > 0,
  );
  const input = (): ComposerInput | null => (sourceMode ? rawField.current : richField.current);
  field.current = {
    get value(): string {
      return input()?.value ?? text;
    },
    get selectionStart(): number {
      return input()?.selectionStart ?? text.length;
    },
    get selectionEnd(): number {
      return input()?.selectionEnd ?? text.length;
    },
    focus: (): void => {
      input()?.focus();
    },
    blur: (): void => {
      input()?.blur();
    },
    setSelectionRange: (start, end): void => {
      input()?.setSelectionRange(start, end);
    },
  };
  const modeChanged = useRef(false);
  const modeSelection = useRef<Selection | null>(null);
  const [linkSelection, setLinkSelection] = useState<Selection | null>(null);
  const pendingLink = useRef<Selection | null>(null);
  const [editingLink, setEditingLink] = useState<{
    readonly label: string;
    readonly address: string;
  } | null>(null);
  useComposerSize(rawField, text, sourceMode);
  useEffect(() => {
    if (!modeChanged.current) return;
    modeChanged.current = false;
    const wanted = modeSelection.current;
    if (wanted !== null) field.current?.setSelectionRange(wanted.start, wanted.end);
    modeSelection.current = null;
    field.current?.focus();
  }, [sourceMode]);
  const hintsId = useId();
  // Where the caret goes after a change that is made by script (a paste, an undo).
  const caret = useRef<number | null>(null);
  const composing = useComposition(card);
  const latest = useRef(text);
  /** The face the last space turned into an emoji, and where the caret was then: Backspace there undoes it (D-253). */
  const madeEmoji = useRef<{
    readonly face: Emoticon;
    readonly space: string;
    readonly caret: number;
  } | null>(null);
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
  const [selection, setSelection] = useState<Selection>({ start: text.length, end: text.length });
  const caretAt = selection.start;
  const setCaretAt = (at: number): void => {
    setSelection({ start: at, end: at });
  };
  const formatRanges = useMemo(
    () => (!sourceMode || unitsOver(text) > 0 ? null : formattingRanges(text)),
    [text, sourceMode],
  );
  const sourceFormats = useMemo(
    () => activeFormatting(text, formatRanges, selection),
    [text, formatRanges, selection],
  );
  const [richFormats, setRichFormats] = useState<ReadonlySet<MarkdownKind>>(new Set());
  const activeFormats = sourceMode ? sourceFormats : richFormats;
  // The `@` whose list Esc closed; it stays closed until a mention starts somewhere else.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  // The `:` whose list Esc closed; like the `@`'s, it stays closed until a shortcode starts elsewhere.
  const [shortcodeDismissedAt, setShortcodeDismissedAt] = useState<number | null>(null);
  const [shortcodeActive, setShortcodeActive] = useState(0);
  const listId = useId();
  const runSlash = useSlashRunner(channelId);
  const [commandActive, setCommandActive] = useState(0);
  // Esc shuts the commands until the `/` is gone. A draft that comes back as one starts shut: the
  // person did not ask for the list on this visit, and on a phone it would cover the feed.
  const [commandsDismissed, setCommandsDismissed] = useState(
    () => slashQuery(text, text.length) !== null,
  );
  const candidates = useMentionCandidates(channelId);
  const { refresh: refreshCandidates } = candidates;

  const draft = useDraftWriter(
    { ...ports, userId: session.user.id, key, isCurrent: engine.isCurrent },
    text,
    latest,
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

  const change = (next: string, meaningful = true): void => {
    latest.current = next;
    if (!sourceMode && unitsOver(next) > 0) setSourceMode(true);
    setText(next);
    // A new letter is a new list, and its best match is the one Enter takes.
    setActive(0);
    setShortcodeActive(0);
    // Rationed by the engine; an emptied box says nothing, and the announcement runs out (D-114).
    // Not from a reply box: what is typed there never arrives in the channel's feed (`UX.md` §5).
    if (parentId === undefined && next.trim() !== '' && meaningful)
      engine.announceTyping(channelId);
    // What was wrong with the old text is not known to be wrong with the new.
    setError(null);
  };

  const fileOffer = useFileOffer({
    text,
    latest,
    caret,
    field,
    change,
    attached: uploads.items.length,
    addFiles: uploads.add,
  });
  const pasteHandler = usePasteHandler({
    key,
    text,
    latest,
    caret,
    field,
    change,
    addFiles: uploads.add,
    offerFile: fileOffer.set,
  });

  /** Where the caret goes once the text a button inserted is in the box. */
  const inserted = useRef<Selection | null>(null);
  useLayoutEffect(() => {
    const box = field.current;
    const wanted = inserted.current;
    if (box === null || wanted === null) return;
    inserted.current = null;
    box.focus();
    box.setSelectionRange(wanted.start, wanted.end);
    setSelection(wanted);
  }, [text]);

  /** One of the three buttons: markdown inserted at the caret, as a key would type it (D-110). */
  const prepareEditor = (): RichInput | null => {
    if (unitsOver(text) > 0) return null;
    const editor = richField.current;
    const box = field.current;
    if (editor !== null && sourceMode && box !== null) {
      editor.loadSource(text, { start: box.selectionStart, end: box.selectionEnd });
    }
    return editor;
  };
  const insert = (kind: MarkdownKind): void => {
    if (
      !sourceMode &&
      richField.current !== null &&
      kind !== 'link' &&
      kind !== 'table' &&
      kind !== 'mention'
    ) {
      richField.current.format(kind);
      return;
    }
    const box = field.current;
    const at = box === null ? text.length : box.selectionStart;
    const to = box === null ? text.length : box.selectionEnd;
    if (kind === 'link') {
      if (richField.current === null) {
        pendingLink.current = { start: at, end: to };
        return;
      }
      setEditingLink(prepareEditor()?.currentLink() ?? null);
      setLinkSelection({ start: at, end: to });
      return;
    }
    const next = insertMarkdown(box?.value ?? text, { start: at, end: to }, kind);
    inserted.current = next.selection;
    change(next.text);
  };

  /**
   * Backspace straight after a face became an emoji: the face comes back as it was typed, with its
   * space, and stays — the space is already there, so nothing turns it again (D-253).
   */
  const undoEmoji = (box: ComposerInput): boolean => {
    const made = madeEmoji.current;
    madeEmoji.current = null;
    if (made?.caret !== box.selectionStart || box.selectionEnd !== box.selectionStart) return false;
    const { face, space } = made;
    const start = face.start;
    if (text.slice(start, made.caret) !== face.emoji + space) return false;
    const back = start + face.typed.length + space.length;
    inserted.current = { start: back, end: back };
    setCaretAt(back);
    change(text.slice(0, start) + face.typed + space + text.slice(made.caret));
    return true;
  };

  /** An emoji from the picker: text where the caret is, as a key would type it. */
  const insertEmoji = (emoji: string): void => {
    if (!sourceMode && richField.current !== null) {
      richField.current.insertText(emoji);
      return;
    }
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
  // An emoji by its name, while a colon and letters are all that is written before the caret.
  const shortcode = focused ? shortcodeQuery(text, caretAt) : null;
  const emojiNames = useEmojiNames(shortcode !== null);
  const shortcodeChoices =
    shortcode !== null && shortcode.start !== shortcodeDismissedAt && emojiNames !== null
      ? emojiNames.suggestShortcodes(shortcode.query)
      : [];
  const shortcodesOpen = shortcodeChoices.length > 0;
  const currentShortcode = Math.min(shortcodeActive, shortcodeChoices.length - 1);
  const shortcodeStart = shortcode?.start ?? null;
  useEffect(() => {
    if (shortcodeStart === null) setShortcodeDismissedAt(null);
  }, [shortcodeStart]);
  // The commands, while a `/` and letters are all that is written before the caret (D-214).
  const typedCommand = slashQuery(text, caretAt);
  const slash = focused ? typedCommand : null;
  const commands = slash !== null && !commandsDismissed ? commandsFor(slash) : [];
  const commandsOpen = commands.length > 0;
  const currentCommand = Math.min(commandActive, commands.length - 1);
  // Shut until the `/` is gone from the text — not until focus leaves, which the mount also is.
  useEffect(() => {
    if (typedCommand === null) setCommandsDismissed(false);
  }, [typedCommand]);
  /** A command chosen from the list: written out with a space after it, for its words. */
  const completeCommand = (name: SlashName): void => {
    const written = `/${name} `;
    const next = written + text.slice(caretAt);
    inserted.current = { start: written.length, end: written.length };
    setCaretAt(written.length);
    change(next);
  };

  /** Somebody chosen from the list: their handle replaces what was typed after the `@`. */
  const choose = (username: string): void => {
    if (mention === null) return;
    const next = insertMention(text, mention, username);
    inserted.current = { start: next.caret, end: next.caret };
    setCaretAt(next.caret);
    change(next.text);
  };

  /** An emoji chosen by name: it replaces the colon and the letters typed after it. */
  const chooseShortcode = (emoji: string): void => {
    if (shortcode === null || emojiNames === null) return;
    const next = emojiNames.insertShortcode(text, shortcode, emoji);
    inserted.current = { start: next.caret, end: next.caret };
    setCaretAt(next.caret);
    change(next.text);
  };

  /** A command and its words, run through what it stands for; its answer said where it belongs. */
  const runCommand = (name: SlashName, args: string): void => {
    setError(null);
    void runSlash(name, args).then((outcome) => {
      if (outcome.kind === 'send') {
        send(outcome.content);
        return;
      }
      if (outcome.kind === 'refused') {
        setError(outcome.reason);
        return;
      }
      latest.current = '';
      setText('');
      writeDraft(ports.storage, key, '');
      if (outcome.said !== '') toast.show({ message: outcome.said });
    });
  };

  /** What is written, as it would be sent: a face that ends the message becomes its emoji, as the space after it would have made it (D-253). */
  const writtenWords = (): string =>
    !sourceMode && richField.current !== null
      ? trimEnd(richField.current.forSend())
      : withClosingEmoji(trimEnd(text));

  /**
   * Why these words cannot be a message, in words — or null. A send and a schedule are refused for
   * the same reasons, so they ask the same question: a file that failed, a message over the limit, a
   * character the contract refuses and an `@here` this channel does not allow.
   */
  const refusalOf = (content: string): string | null => {
    // A file that did not upload is the person's to retry or remove: nothing goes without it.
    if (uploads.items.some((item) => item.status === 'failed' || item.status === 'too-large'))
      return t('composer.uploadFailed');
    const over = unitsOver(content);
    if (over > 0) return t('composer.tooLong', { count: over });
    if (content !== '' && !Value.Check(MessageContent, content)) return t('composer.invalid');
    const mention = broadcastMention(content);
    return mention === null ? null : t('composer.broadcast', { mention });
  };

  /** The box and its draft emptied, as a send leaves them: gone from storage now, not a debounce from now (a reload must not bring back what was sent). */
  const clearWritten = (): void => {
    uploads.clear();
    setWaiting(false);
    fileOffer.set(null);
    pasteHandler.dismissNotice();
    latest.current = '';
    setText('');
    setError(null);
    writeDraft(ports.storage, key, '');
    field.current?.focus();
  };

  /** Sends what is written — or, from a command, the words it wrote (`/me`, `/shrug`). */
  const send = (written?: string): void => {
    const typed = written ?? writtenWords();
    // A line that starts with `/` asks for a command (D-214) — unless files go with it, when it is words.
    const line = written === undefined && uploads.items.length === 0 ? parseSlash(typed) : null;
    if (line?.kind === 'unknown') {
      setError(
        t('slash.unknown', { name: line.name, all: SLASH_COMMANDS.map((c) => `/${c}`).join(' ') }),
      );
      return;
    }
    if (line?.kind === 'command') {
      runCommand(line.name, line.args);
      return;
    }
    const content = line?.kind === 'escaped' ? line.text : typed;
    if (content === '' && uploads.items.length === 0) return;
    const refusal = refusalOf(content);
    if (refusal !== null) {
      if (uploads.items.some((item) => item.status === 'failed' || item.status === 'too-large'))
        setWaiting(false);
      setError(refusal);
      return;
    }
    // Still uploading: it goes when they land, and says so meanwhile (`UX.md` §5).
    if (uploads.items.some((item) => item.status === 'uploading')) {
      setWaiting(true);
      setError(null);
      return;
    }
    let id: string;
    try {
      id = engine.send({
        channelId,
        content,
        ...(parentId === undefined ? {} : { parentId }),
        attachments: uploads.items.flatMap((item) =>
          item.status === 'ready' ? [item.attachment] : [],
        ),
      });
    } catch (failure) {
      if (!isApiError(failure) || failure.code !== 'UNAUTHENTICATED') throw failure;
      setWaiting(false);
      setError(t('composer.accountChanged'));
      return;
    }
    if (hasPartyPopper(content)) celebrate();
    clearWritten();
    onSent?.(id);
  };

  const canSchedule = useRunsIfAny('chat');
  const scheduleMessage = useScheduleMessage();
  /** What is written, held to be sent at `sendAt`: refused for the reasons a send is, and kept where it is when the server says no. */
  const scheduleLater = (sendAt: Date): void => {
    const typed = writtenWords();
    const line = uploads.items.length === 0 ? parseSlash(typed) : null;
    if (line?.kind === 'unknown' || line?.kind === 'command') {
      setError(t('scheduled.refuse.command'));
      return;
    }
    const content = line?.kind === 'escaped' ? line.text : typed;
    if (content === '' && uploads.items.length === 0) {
      setError(t('scheduled.refuse.empty'));
      return;
    }
    const refusal = refusalOf(content);
    if (refusal !== null) {
      setError(refusal);
      return;
    }
    if (uploads.items.some((item) => item.status === 'uploading')) {
      setError(t('scheduled.refuse.uploading'));
      return;
    }
    const asked = latest.current;
    setError(null);
    void scheduleMessage({
      channelId,
      ...(parentId === undefined ? {} : { parentId }),
      content,
      attachmentIds: uploads.items.flatMap((item) =>
        item.status === 'ready' ? [item.attachment.id] : [],
      ),
      sendAt,
    }).then((failure) => {
      if (failure !== null) {
        setError(failure);
        return;
      }
      // Words typed while it was on its way are the person's, and stay.
      if (latest.current === asked) clearWritten();
    });
  };

  const onKeyDown = (event: ComposerKeyEvent): void => {
    // The platform's "paste as plain text": the paste that follows is taken as it is (D-210).
    pasteHandler.noteKey(event);
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
    if (sourceMode && event.key === 'Backspace' && undoEmoji(event.currentTarget)) {
      event.preventDefault();
      return;
    }
    if (commandsOpen) {
      const plain = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setCommandActive((currentCommand + step + commands.length) % commands.length);
        return;
      }
      // Tab completes; Enter completes too, unless the command is already whole and takes no words.
      const whole = slash !== null && commands[currentCommand] === slash;
      if ((event.key === 'Tab' || (event.key === 'Enter' && !whole)) && plain) {
        event.preventDefault();
        const chosen = commands[currentCommand];
        if (chosen !== undefined) completeCommand(chosen);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setCommandsDismissed(true);
        return;
      }
    }
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
    if (shortcode !== null && emojiNames !== null) {
      const asked = emojiNames.shortcodeKey(
        event,
        shortcode.query,
        shortcodeChoices,
        currentShortcode,
      );
      if (asked !== null) {
        event.preventDefault();
        if (asked === 'close') {
          event.stopPropagation();
          setShortcodeDismissedAt(shortcode.start);
        } else if (typeof asked === 'number') setShortcodeActive(asked);
        else chooseShortcode(asked.emoji);
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
    const wrapped = sourceMode
      ? typedWrap(event, { start: box.selectionStart, end: box.selectionEnd })
      : null;
    if (wrapped !== null) {
      event.preventDefault();
      insert(wrapped);
      return;
    }
    const action = enterAction(
      event,
      !sourceMode && richField.current?.inCode ? '```\n' : box.value.slice(0, box.selectionStart),
      ports.touchOnly?.() ?? false,
    );
    if (action === null) return;
    if (action === 'submit') {
      event.preventDefault();
      send();
      return;
    }
    if (!sourceMode) richField.current?.finishFace();
    // A new line. In a list or a quote it carries the marker on, and an empty item ends the list;
    // elsewhere — and inside a fence — the browser's own line break is right (D-181, D-188).
    if (sourceMode && !event.metaKey && !event.ctrlKey && box.selectionStart === box.selectionEnd) {
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

  // A quote sent here from a message's menu (D-213): after what is written, on lines of its own,
  // the caret under it to answer.
  useComposerInbox(
    composerKey(channelId, parentId ?? null),
    (markdown) => {
      const gap = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
      const next = `${text}${gap}${markdown}`;
      caret.current = next.length;
      change(next);
    },
    () => {
      field.current?.focus();
    },
  );

  // The key printed in a tooltip: only the words depend on the platform, never the behaviour.
  const mac = isMacPlatform(typeof navigator === 'undefined' ? {} : navigator);
  const labels = keyLabels(mac);
  const chord = (...parts: readonly string[]): string => parts.join(mac ? '' : '+');
  /** Both modes edit the same GFM draft and restore the current selection. */
  const togglePreview = (): void => {
    if (sourceMode && unitsOver(text) > 0) return;
    const box = field.current;
    modeSelection.current =
      box === null ? null : { start: box.selectionStart, end: box.selectionEnd };
    modeChanged.current = true;
    try {
      ports.storage?.setItem(SOURCE_MODE_KEY, String(!sourceMode));
    } catch {
      /* Writing remains available when storage is blocked. */
    }
    setSourceMode((now) => !now);
  };
  const left = unitsLeft(text);
  const rows = rowsFor(text, 2);

  const compact = parentId !== undefined;
  const empty = trimEnd(text) === '' || (!sourceMode && richField.current?.empty === true);
  // Inside an open fence, and on a phone, Enter is a new line, so the key that sends is the one the hint
  // names (D-188) — and the field's description, which a screen reader reads at every width, says it too.
  const fenced =
    (!sourceMode && richFormats.has('code')) ||
    insideFence(text.slice(0, caretAt)) ||
    (ports.touchOnly?.() ?? false);
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
      onClick={() => {
        send();
      }}
      aria-disabled={empty && uploads.items.length === 0}
      aria-label={t('composer.send')}
      className={cn(
        'inline-flex h-control shrink-0 items-center justify-center gap-2 rounded-md bg-accent text-label font-medium text-on-accent transition-colors duration-hover ease-standard hover:bg-accent-hover aria-disabled:cursor-not-allowed aria-disabled:bg-surface-200 aria-disabled:text-ink-muted max-narrow:h-touch',
        compact ? 'aspect-square' : 'px-3 max-narrow:aspect-square max-narrow:px-0',
      )}
    >
      <Icon name="send" size="sm" />
      {!compact && <span className="max-narrow:hidden">{t('composer.send')}</span>}
    </button>
  );

  const pendingOffer = fileOffer.offer;
  const fieldLabel = t('composer.label', { channel: channelName });
  const fieldPlaceholder = t('composer.placeholder', { channel: channelName });
  const controls = commandsOpen
    ? commandListId(listId)
    : open
      ? mentionListId(listId)
      : shortcodesOpen
        ? shortcodeListId(listId)
        : undefined;
  const activeDescendant = commandsOpen
    ? commandOptionId(listId, commands[currentCommand] ?? '')
    : open
      ? mentionOptionId(listId, current)
      : shortcodesOpen
        ? shortcodeOptionId(listId, currentShortcode)
        : undefined;

  return (
    <div className="shrink-0 pb-4 pt-2">
      <div className="flex w-full flex-col gap-2 px-6 max-narrow:px-4">
        <div
          ref={card}
          data-composer-card=""
          onKeyDown={(event) => {
            if (
              !event.defaultPrevented &&
              event.target instanceof HTMLElement &&
              event.currentTarget.contains(event.target) &&
              formatKey(event) === 'preview'
            ) {
              event.preventDefault();
              togglePreview();
            }
          }}
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
            'relative flex flex-col rounded-2xl border-hairline bg-surface-100 shadow-raised transition-colors duration-hover ease-standard',
            // One line of one weight, at rest and focused: the focused edge is the same hairline in a firmer
            // neutral grey, not a second, thicker ring (D-207). A blue held for as long as somebody types is the
            // brightest thing on the screen; the caret says where the typing is.
            focused ? 'border-composer-focus' : 'border-composer-rest hover:border-composer-hover',
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
          {commandsOpen && (
            <CommandList
              listId={listId}
              commands={commands}
              current={currentCommand}
              onChoose={completeCommand}
              onHover={setCommandActive}
            />
          )}
          {open && (
            <MentionList
              listId={listId}
              people={suggestions}
              current={current}
              onChoose={choose}
              onHover={setActive}
            />
          )}
          {shortcodesOpen && emojiNames !== null && (
            <emojiNames.ShortcodeList
              listId={listId}
              choices={shortcodeChoices}
              current={currentShortcode}
              onChoose={chooseShortcode}
              onHover={setShortcodeActive}
            />
          )}
          <VisuallyHidden role="status" aria-live="polite">
            {open
              ? t('mention.results', { count: suggestions.length })
              : shortcodesOpen
                ? t('shortcode.results', { count: shortcodeChoices.length })
                : ''}
          </VisuallyHidden>
          <FormatToolbar
            sourceMode={sourceMode}
            active={activeFormats}
            labels={labels}
            chord={chord}
            onInsert={insert}
            onTogglePreview={togglePreview}
            editingReady={richReady && unitsOver(text) <= 0}
            onClear={() => {
              prepareEditor()?.clearFormatting();
            }}
          />
          <div className="flex gap-2 px-4 pb-2 pt-3 max-narrow:px-3">
            <textarea
              data-composer={sourceMode ? '' : undefined}
              ref={rawField}
              rows={rows}
              value={text}
              aria-label={fieldLabel}
              aria-invalid={error === null ? undefined : true}
              aria-describedby={hintsId}
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-controls={controls}
              aria-activedescendant={activeDescendant}
              placeholder={fieldPlaceholder}
              hidden={!sourceMode}
              className="min-w-0 flex-1 resize-none overflow-y-auto bg-transparent text-body text-ink outline-none placeholder:text-ink-subtle max-narrow:text-title max-narrow:font-normal scrollbar-thin"
              onChange={(event) => {
                const { value, selectionStart, selectionEnd } = event.target;
                madeEmoji.current = null;
                // A space or a new line after a face makes it an emoji (D-253); not while an IME is composing.
                const made = composing.current ? null : typedAfterFace(text, value, selectionStart);
                if (made !== null) {
                  madeEmoji.current = {
                    face: made.face,
                    space: value.charAt(selectionStart - 1),
                    caret: made.caret,
                  };
                  inserted.current = { start: made.caret, end: made.caret };
                  setCaretAt(made.caret);
                  change(made.text);
                  return;
                }
                change(value);
                setSelection({ start: selectionStart, end: selectionEnd });
                // The `@` that was dismissed is gone: the next one opens again.
                if (mentionQuery(value, selectionStart) === null) setDismissedAt(null);
              }}
              onSelect={(event) => {
                const { selectionStart, selectionEnd } = event.currentTarget;
                setSelection({ start: selectionStart, end: selectionEnd });
              }}
              onKeyDown={onKeyDown}
              onPaste={pasteHandler.onPaste}
            />
            {
              <Suspense
                fallback={
                  <div role="status" className="min-h-touch flex-1 text-body text-ink-muted">
                    {t('composer.loadingEditor')}
                  </div>
                }
              >
                <RichEditor
                  input={richField}
                  hidden={sourceMode}
                  autoFocus={autoFocus}
                  value={text}
                  label={fieldLabel}
                  description={hintsId}
                  placeholder={fieldPlaceholder}
                  taskLabel={t('composer.tasks')}
                  invalid={error !== null}
                  controls={controls}
                  activeDescendant={activeDescendant}
                  onChange={(next, selected) => {
                    if (sourceMode) inserted.current = selected;
                    change(next, richField.current?.empty !== true);
                    setSelection(selected);
                  }}
                  onSelect={(selected, formats) => {
                    setSelection(selected);
                    setRichFormats(formats);
                  }}
                  onKeyDown={onKeyDown}
                  onPaste={pasteHandler.onPaste}
                  onUseSource={() => {
                    setSourceMode(true);
                  }}
                  onReady={() => {
                    setRichReady(true);
                    const queued = pendingLink.current;
                    const editor = richField.current;
                    if (queued !== null && editor !== null) {
                      pendingLink.current = null;
                      if (sourceMode && unitsOver(latest.current) <= 0)
                        editor.loadSource(latest.current, queued);
                      setEditingLink(unitsOver(latest.current) <= 0 ? editor.currentLink() : null);
                      setLinkSelection(queued);
                    }
                  }}
                />
              </Suspense>
            }
          </div>
          {!sourceMode && richFormats.has('code') && (
            <div className="px-4 pb-2 max-narrow:px-3">
              <button
                type="button"
                className="inline-flex min-h-control items-center rounded-md text-label text-accent-text underline max-narrow:min-h-touch"
                onClick={() => {
                  richField.current?.leaveCode();
                }}
              >
                {t('composer.leaveCode')}
              </button>
            </div>
          )}
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
                  thread, on a phone or where there is no keyboard it divided the buttons from nothing. */}
              {focused && !compact && (
                <span
                  aria-hidden="true"
                  data-hints-divider=""
                  className="mx-1 h-4 border-l-hairline border-border-subtle max-narrow:hidden touch-only:hidden"
                />
              )}
            </span>
            <KeyHints
              id={hintsId}
              drawn={focused && !compact}
              fenced={fenced}
              labels={labels}
              chord={chord}
            />
            {!compact && <TypingLine channelId={channelId} />}
            {counter}
            {canSchedule && <SendLater onSchedule={scheduleLater} />}
            {sendButton}
          </div>
          {linkSelection !== null && (
            <Suspense fallback={null}>
              <LinkDialog
                existing={editingLink}
                selection={
                  !sourceMode
                    ? (richField.current?.selectedText ?? '')
                    : text.slice(linkSelection.start, linkSelection.end)
                }
                returnFocus={() =>
                  sourceMode ? rawField.current : (richField.current?.element ?? null)
                }
                onClose={() => {
                  setLinkSelection(null);
                }}
                onInsert={(label, address) => {
                  if ((!sourceMode || editingLink !== null) && richField.current !== null) {
                    richField.current.insertLink(label, address);
                    setLinkSelection(null);
                    return;
                  }
                  const next = insertLink(text, linkSelection, label, address);
                  if (next === null) return;
                  inserted.current = next.selection;
                  change(next.text);
                  setLinkSelection(null);
                }}
                onRemove={() => {
                  richField.current?.removeLink();
                  setLinkSelection(null);
                }}
              />
            </Suspense>
          )}
        </div>
        {draft.failed && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 px-1 text-label text-danger-text"
          >
            <Icon name="failed" size="sm" />
            <span>{t(text === '' ? 'composer.draftClearFailed' : 'composer.draftFailed')}</span>
            <button
              type="button"
              className="inline-flex min-h-control items-center rounded-md underline max-narrow:min-h-touch"
              onClick={() => {
                draft.retry();
                field.current?.focus();
              }}
            >
              {t('common.retry')}
            </button>
          </div>
        )}
        {waiting && (
          <p role="status" className="flex items-center gap-2 px-1 text-label text-ink-muted">
            <Icon name="sending" size="sm" />
            {t('composer.waiting')}
          </p>
        )}
        {/* A live region that is there before its content, or most screen readers say nothing of it. */}
        <div role="status" className="empty:hidden">
          {pendingOffer !== null && (
            <FileOfferBar
              offer={pendingOffer.file}
              table={pendingOffer.table}
              onKeep={fileOffer.keep}
              onAccept={() => {
                fileOffer.accept(pendingOffer);
              }}
            />
          )}
        </div>
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
