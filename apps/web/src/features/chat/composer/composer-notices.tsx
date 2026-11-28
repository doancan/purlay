/**
 * What the composer says under its card: a draft that could not be kept or cleared, what is waiting on an upload, a
 * long paste offered as a file, and why a send was refused. Presentation only: each answer is the composer's to
 * give, so this takes the words' inputs and the two actions and decides nothing.
 *
 * The offer sits in a live region that is there before its content, or most screen readers say nothing of it.
 */
import { Icon } from '../../../components/icon';
import { useI18n } from '../../../i18n/i18n-provider';
import { FileOfferBar, type PendingOffer } from './file-offer';

export interface ComposerNoticesProps {
  /** The draft could not be written or cleared; `retry` tries again. */
  readonly draftFailed: boolean;
  readonly boxIsEmpty: boolean;
  readonly onRetryDraft: () => void;
  /** An upload the send is waiting for. */
  readonly waiting: boolean;
  readonly offer: PendingOffer | null;
  readonly onKeepOffer: () => void;
  readonly onAcceptOffer: (offer: PendingOffer) => void;
  /** Why the last send was refused, in words, or null. */
  readonly error: string | null;
}

export const ComposerNotices = ({
  draftFailed,
  boxIsEmpty,
  onRetryDraft,
  waiting,
  offer,
  onKeepOffer,
  onAcceptOffer,
  error,
}: ComposerNoticesProps): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <>
      {draftFailed && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 px-1 text-label text-danger-text"
        >
          <Icon name="failed" size="sm" />
          <span>{t(boxIsEmpty ? 'composer.draftClearFailed' : 'composer.draftFailed')}</span>
          <button
            type="button"
            className="inline-flex min-h-control items-center rounded-md underline max-narrow:min-h-touch"
            onClick={onRetryDraft}
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
      <div role="status" className="empty:hidden">
        {offer !== null && (
          <FileOfferBar
            offer={offer.file}
            table={offer.table}
            onKeep={onKeepOffer}
            onAccept={() => {
              onAcceptOffer(offer);
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
    </>
  );
};
