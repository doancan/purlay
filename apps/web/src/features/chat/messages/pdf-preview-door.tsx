/** A PDF reader is requested explicitly and only one is open; the SDK never enters the feed chunk. */
import { useEffect, useId, useRef, useState } from 'react';
import type { Attachment } from '@purlay/types';
import { useI18n } from '../../../i18n/i18n-provider';
import { IconButton } from '../../../ui/icon-button';
import { LoadingStatus } from '../../../ui/skeleton';
import { ErrorState } from '../../../ui/states';
import { PDF_LIMITS } from './pdf-limits';
import type { ConnectedPdfPreview } from './pdf-preview';
import type * as PdfModule from './pdf-preview';
import type { Schedule } from '../../../realtime/connection';
import { browserSchedule } from '../../../realtime/socket';

export interface PdfDoorPorts {
  readonly load: () => Promise<Pick<typeof PdfModule, 'ConnectedPdfPreview'>>;
  readonly schedule: Schedule;
}
const browserPorts: PdfDoorPorts = {
  load: () => import('./pdf-preview'),
  schedule: browserSchedule,
};

const readers = new Set<() => void>();

const Door = ({
  attachment,
  id,
  onClose,
  ports,
}: {
  readonly attachment: Attachment;
  readonly id: string;
  readonly onClose: () => void;
  readonly ports: PdfDoorPorts;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [View, setView] = useState<typeof ConnectedPdfPreview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const cancel = ports.schedule(() => {
      live = false;
      setFailed(true);
    }, PDF_LIMITS.deadlineMs);
    ports.load().then(
      (module) => {
        if (!live) return;
        cancel();
        setView(() => module.ConnectedPdfPreview);
      },
      () => {
        if (live) {
          cancel();
          setFailed(true);
        }
      },
    );
    return (): void => {
      live = false;
      cancel();
    };
  }, [ports]);
  if (View !== null) return <View attachment={attachment} id={id} onClose={onClose} />;
  return (
    <section
      id={id}
      aria-label={t('attachment.preview.label', { name: attachment.fileName })}
      className="rounded-xl border-hairline border-border-subtle bg-surface-100 p-3"
    >
      {failed ? (
        <ErrorState
          title={t('attachment.preview.failed')}
          body={t('pdf.chunkFailed')}
          retryLabel={t('pdf.reload')}
          onRetry={() => {
            window.location.reload();
          }}
        />
      ) : (
        <LoadingStatus label={t('attachment.preview.loading')}>{null}</LoadingStatus>
      )}
    </section>
  );
};

export const PdfAttachment = ({
  attachment,
  card,
  ports = browserPorts,
}: {
  readonly attachment: Attachment;
  readonly card: React.ReactNode;
  readonly ports?: PdfDoorPorts;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const close = (): void => {
      setOpen(false);
    };
    readers.add(close);
    return (): void => {
      readers.delete(close);
    };
  }, []);
  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-1">
        {card}
        <IconButton
          ref={trigger}
          glyph="preview"
          label={t(open ? 'attachment.preview.hide' : 'attachment.preview.show', {
            name: attachment.fileName,
          })}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            if (open) setOpen(false);
            else {
              for (const close of readers) close();
              setOpen(true);
            }
          }}
        />
      </div>
      {open && (
        <Door
          key={attachment.id}
          attachment={attachment}
          id={id}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
          ports={ports}
        />
      )}
    </div>
  );
};
