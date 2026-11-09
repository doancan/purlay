/**
 * What the composer does with a paste (D-205, D-210, D-259): a picture or file is uploaded, code, a
 * table, formatting or a link is turned into markdown with a toast that undoes it, and a text too long
 * for a message is left in the box with a file offered. It changes the box only through `change`, so
 * the composer stays the one place that writes its text.
 */
import { useContext, useEffect, useRef } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { RealtimePortsContext } from '../../../realtime/realtime-provider';
import { systemClock } from '../../../system-clock';
import { useToast } from '../../../ui/toast';
import { insertText, insideFence, placeBlock, undoPaste } from './composer-text';
import type { PendingOffer } from './file-offer';
import { convertPaste, fileOfferFor, isLargeTable, type PasteKind } from './paste';
import { pastedFiles } from './paste-shapes';

/** What the toast says of each conversion a paste can make (D-210, D-259). */
const PASTE_SAID: Readonly<
  Record<
    PasteKind,
    | 'composer.pasted'
    | 'composer.pasted.table'
    | 'composer.pasted.formatted'
    | 'composer.pasted.inline'
    | 'composer.pasted.link'
    | 'composer.pasted.list'
  >
> = {
  code: 'composer.pasted',
  table: 'composer.pasted.table',
  formatted: 'composer.pasted.formatted',
  inline: 'composer.pasted.inline',
  link: 'composer.pasted.link',
  list: 'composer.pasted.list',
};

/** Conversions that are Undo, not Paste as text: what was pasted was code, a link — a guess about words. */
const UNDOABLE: ReadonlySet<PasteKind> = new Set<PasteKind>(['code', 'inline', 'link']);

/** What a paste reads and changes in the composer, and nothing else of it. */
export interface PasteTarget {
  /** Where the draft is kept: a paste's toast is dismissed when the composer moves to another place. */
  readonly key: string;
  readonly text: string;
  /** The text as of the last render, for an Undo pressed later. */
  readonly latest: React.RefObject<string>;
  /** Where the caret goes once the text a paste put in is in the box. */
  readonly caret: React.RefObject<number | null>;
  readonly field: React.RefObject<HTMLTextAreaElement | null>;
  readonly change: (next: string) => void;
  readonly addFiles: (files: readonly File[]) => void;
  readonly offerFile: (offer: PendingOffer) => void;
}

export interface PasteHandler {
  readonly onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  /** Called with every key: Mod+Shift+V, the platform's "paste as plain text", marks the paste that follows. */
  readonly noteKey: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Takes the toast of the last conversion away: what it offered to undo has been sent. */
  readonly dismissNotice: () => void;
}

export const usePasteHandler = (target: PasteTarget): PasteHandler => {
  const { key, text, latest, caret, field, change, addFiles, offerFile } = target;
  const { t } = useI18n();
  const toast = useToast();
  const { dismiss } = toast;
  // The page's clock, the one a test drives: files are named for the minute they were made (D-259).
  const clock = useContext(RealtimePortsContext).clock ?? systemClock;
  const pasteToast = useRef<number | null>(null);
  /** Set by Mod+Shift+V, read by the paste it starts. */
  const plainNext = useRef(false);

  useEffect(
    () => (): void => {
      if (pasteToast.current !== null) dismiss(pasteToast.current);
    },
    [key, dismiss],
  );

  const dismissNotice = (): void => {
    if (pasteToast.current !== null) dismiss(pasteToast.current);
  };

  const noteKey = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    plainNext.current =
      (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'v';
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const data = event.clipboardData as DataTransfer | undefined;
    const raw = data?.getData('text/plain') ?? '';
    // Windows and old Macs end a line with CR LF or CR; a byte-order mark comes from a file's first line.
    const pasted = raw.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    // A pasted image or file is uploaded, not written into the box — unless the clipboard's words are
    // what was copied: a spreadsheet's range comes with a picture of itself (D-259). Some engines only
    // list a pasted file under `items`.
    const listed = Array.from(data?.files ?? []);
    const carried =
      listed.length > 0
        ? listed
        : Array.from(data?.items ?? []).flatMap((item) => {
            const file = item.kind === 'file' ? item.getAsFile() : null;
            return file === null ? [] : [file];
          });
    const files = pastedFiles(carried, pasted, clock.now());
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
      return;
    }
    const target = event.currentTarget;
    const selection = { start: target.selectionStart, end: target.selectionEnd };
    const selected = text.slice(selection.start, selection.end);
    // Mod+Shift+V asked for the words as they are (D-210), and inside code the words are what is
    // written: nothing is turned into anything (D-205).
    const inCode = insideFence(text.slice(0, selection.start));
    const plain = plainNext.current || inCode;
    plainNext.current = false;
    const converted = plain
      ? null
      : convertPaste(pasted, data?.getData('text/html') ?? '', selected);
    // Too long for a message: the words are kept where they are, and a file is one answer away.
    const fileOffer = inCode ? null : fileOfferFor(pasted, clock.now());
    // The box takes the words as they are written here — not as the browser would insert them, which
    // keeps a byte-order mark and may keep a CR — whenever the offer must find them again, or they differ.
    const manual = converted === null && (fileOffer !== null || pasted !== raw);
    if (converted === null && !manual) {
      // The words the browser inserts. A picture the clipboard carried with them is left out; one press
      // attaches it, since words winning was a guess about what was meant.
      if (carried.length > 0) {
        if (pasteToast.current !== null) dismiss(pasteToast.current);
        pasteToast.current = toast.show({
          message: t('composer.pasted.pictureLeft'),
          actionLabel: t('composer.pasted.attachPicture'),
          onAction: () => {
            addFiles(pastedFiles(carried, '', clock.now()));
          },
        });
      }
      return;
    }
    event.preventDefault();
    if (converted === null) {
      const inserted = insertText(text, selection, pasted);
      caret.current = inserted.selection.end;
      change(inserted.text);
      if (fileOffer !== null) {
        offerFile({
          file: fileOffer,
          words: pasted,
          at: selection.start,
          table: isLargeTable(pasted),
        });
      }
      return;
    }
    const placed = converted.block
      ? placeBlock(text, selection, converted.markdown)
      : {
          text: text.slice(0, selection.start) + converted.markdown + text.slice(selection.end),
          caret: selection.start + converted.markdown.length,
          start: selection.start,
        };
    if (fileOffer !== null) {
      offerFile({
        file: fileOffer,
        words: converted.markdown,
        at: placed.start,
        table: isLargeTable(pasted),
      });
    }
    // What was put in, with the line breaks that set it apart: Undo finds it and puts the words back.
    const block = placed.text.slice(selection.start, placed.caret);
    caret.current = placed.caret;
    change(placed.text);
    if (pasteToast.current !== null) dismiss(pasteToast.current);
    // A table or formatting is a guess about what was meant: the words as they were are one step away.
    // Later edits are kept either way; a block that has itself been edited is left as it is (D-205).
    // A link replaced the words it was pasted over: Undo gives *them* back, not the address.
    pasteToast.current = toast.show({
      message: t(PASTE_SAID[converted.kind]),
      actionLabel: t(UNDOABLE.has(converted.kind) ? 'common.undo' : 'composer.pasted.asText'),
      onAction: () => {
        const undone = undoPaste(
          latest.current,
          block,
          converted.kind === 'link' ? selected : pasted,
        );
        if (undone === null) {
          toast.show({ message: t('composer.pasteChanged') });
          return;
        }
        caret.current = undone.selection.end;
        change(undone.text);
        field.current?.focus();
      },
    });
  };

  return { onPaste, noteKey, dismissNotice };
};
