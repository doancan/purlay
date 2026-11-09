/**
 * The offer a very long paste leaves under the box (D-259): the words stay where they were pasted, and
 * a row — not a toast, which would be gone before a phone's thumb reached it — asks whether they should
 * be a file instead. It stays until it is answered, the words are edited, or the message is sent.
 */
import { ATTACHMENT_BYTES_MAX, ATTACHMENTS_PER_MESSAGE_MAX } from '@purlay/types';
import { useEffect, useState } from 'react';
import { Icon } from '../../../components/icon';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { useToast } from '../../../ui/toast';
import { withoutBlock } from './composer-text';
import type { FileOffer } from './paste';

/** A paste too long for a message, and the words it put in the box: offered as a file until answered. */
export interface PendingOffer {
  readonly file: FileOffer;
  /** What the paste put in the box, and where, so Send as file takes out that and not an earlier copy. */
  readonly words: string;
  readonly at: number;
  readonly table: boolean;
}

export interface FileOfferBarProps {
  readonly offer: FileOffer;
  /** Whether it is a table, which has its own words. */
  readonly table: boolean;
  readonly onAccept: () => void;
  readonly onKeep: () => void;
}

export const FileOfferBar = ({
  offer,
  table,
  onAccept,
  onKeep,
}: FileOfferBarProps): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border-hairline border-border-subtle bg-surface-100 px-3 py-2 text-label text-ink-muted">
      <Icon name="attach" size="sm" />
      <span className="min-w-0 flex-1">
        {t(table ? 'composer.offer.table' : 'composer.offer.long', { lines: offer.lines })}
        <span className="ml-1 font-mono text-caption">{offer.name}</span>
      </span>
      <span className="flex items-center gap-2">
        <Button variant="primary" onClick={onAccept}>
          {t('composer.offer.accept')}
        </Button>
        <Button variant="ghost" onClick={onKeep}>
          {t('composer.offer.keep')}
        </Button>
      </span>
    </div>
  );
};

/** What answering an offer reads and changes in the composer, and nothing else of it. */
export interface FileOfferTarget {
  readonly text: string;
  /** The text as of the last render: the answer comes after the render that drew the offer. */
  readonly latest: React.RefObject<string>;
  /** Where the caret goes once the words have left the box. */
  readonly caret: React.RefObject<number | null>;
  readonly field: React.RefObject<HTMLTextAreaElement | null>;
  readonly change: (next: string) => void;
  /** How many files the message already carries. */
  readonly attached: number;
  readonly addFiles: (files: readonly File[]) => void;
}

export interface FileOfferState {
  readonly offer: PendingOffer | null;
  readonly set: (offer: PendingOffer | null) => void;
  /** Keep the words in the box as they are. */
  readonly keep: () => void;
  /** Send the words as a file instead: they leave the box only when the file can take them. */
  readonly accept: (offer: PendingOffer) => void;
}

export const useFileOffer = ({
  text,
  latest,
  caret,
  field,
  change,
  attached,
  addFiles,
}: FileOfferTarget): FileOfferState => {
  const { t } = useI18n();
  const toast = useToast();
  const [offer, set] = useState<PendingOffer | null>(null);
  // Words that have been edited away are not offered again if they come back (an undo, the same paste).
  useEffect(() => {
    if (offer !== null && !text.includes(offer.words)) set(null);
  }, [text, offer]);

  const keep = (): void => {
    set(null);
    field.current?.focus();
  };

  const accept = (pending: PendingOffer): void => {
    const wanted = latest.current.startsWith(pending.words, pending.at)
      ? pending.at
      : latest.current.indexOf(pending.words);
    if (wanted < 0) {
      set(null);
      toast.show({ message: t('composer.offer.changed') });
      return;
    }
    // The words leave the box only when the file can take them: never to a refusal.
    if (attached >= ATTACHMENTS_PER_MESSAGE_MAX) {
      toast.show({ message: t('composer.offer.noRoom') });
      return;
    }
    if (new Blob([pending.file.text]).size > ATTACHMENT_BYTES_MAX) {
      toast.show({
        message: t('composer.offer.tooLarge', {
          limit: `${String(ATTACHMENT_BYTES_MAX / 1_048_576)} MB`,
        }),
      });
      return;
    }
    const rest = withoutBlock(latest.current, wanted, pending.words);
    set(null);
    caret.current = rest.caret;
    change(rest.text);
    addFiles([new File([pending.file.text], pending.file.name, { type: pending.file.type })]);
    field.current?.focus();
  };

  return { offer, set, keep, accept };
};
