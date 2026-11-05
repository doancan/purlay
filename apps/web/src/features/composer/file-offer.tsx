/**
 * The offer a very long paste leaves under the box (D-259): the words stay where they were pasted, and
 * a row — not a toast, which would be gone before a phone's thumb reached it — asks whether they should
 * be a file instead. It stays until it is answered, the words are edited, or the message is sent.
 */
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import type { FileOffer } from './paste';

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
