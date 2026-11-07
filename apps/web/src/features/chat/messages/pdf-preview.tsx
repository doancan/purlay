/** A single inline page, with a fresh authorized read after every open, reconnect or background stay. */
import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '@purlay/types';
import { useApi } from '../../../data/api-provider';
import { ApiError } from '../../../data/errors';
import { BinaryLimitError } from '../../../data/http-binary';
import { useI18n } from '../../../i18n/i18n-provider';
import type { PlainKey } from '../../../i18n/types';
import type { ConnectionStatus, Schedule } from '../../../realtime/connection';
import { useConnectionStatus } from '../../../realtime/realtime-provider';
import { browserSchedule } from '../../../realtime/socket';
import { Icon } from '../../../components/icon';
import { IconButton } from '../../../ui/icon-button';
import { Select } from '../../../ui/select';
import { LoadingStatus } from '../../../ui/skeleton';
import { ErrorState } from '../../../ui/states';
import { PDF_LIMITS, PdfPreviewError, type PageGeometry } from './pdf-limits';
import { openPdf, type PdfReader } from './pdf-reader';

interface Props {
  readonly attachment: Attachment;
  readonly id: string;
  readonly onClose: () => void;
  readonly status: ConnectionStatus;
  readonly start?: typeof openPdf;
  readonly schedule?: Schedule;
}

const errorBody = (error: unknown): PlainKey => {
  if (
    error instanceof BinaryLimitError ||
    (error instanceof PdfPreviewError && error.kind === 'limits')
  )
    return 'pdf.limited';
  if (error instanceof PdfPreviewError && error.kind === 'timeout') return 'pdf.timeout';
  if (error instanceof ApiError && (error.status === 401 || error.status === 404))
    return 'pdf.denied';
  if (error instanceof Error && error.name === 'PasswordException') return 'pdf.password';
  return 'attachment.preview.failedBody';
};

export const PdfPreview = ({
  attachment,
  id,
  onClose,
  status,
  start = openPdf,
  schedule = browserSchedule,
}: Props): React.JSX.Element => {
  const { t, format } = useI18n();
  const api = useApi();
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const current = useRef<PdfReader | null>(null);
  const request = useRef<AbortController | null>(null);
  const queue = useRef(Promise.resolve());
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const [reader, setReader] = useState<PdfReader | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(true);
  const [failure, setFailure] = useState<unknown>(null);
  const [drawn, setDrawn] = useState<(PageGeometry & { readonly hasText: boolean }) | null>(null);
  const active = visible && status === 'open';

  useEffect(() => {
    const element = stage.current;
    if (element === null) return;
    const measure = (): void => {
      setWidth(element.clientWidth);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return (): void => {
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    const changed = (): void => {
      if (document.visibilityState === 'hidden') {
        request.current?.abort();
        current.current?.close();
        current.current = null;
        setReader(null);
        setDrawn(null);
      }
      setVisible(document.visibilityState !== 'hidden');
    };
    document.addEventListener('visibilitychange', changed);
    return (): void => {
      document.removeEventListener('visibilitychange', changed);
    };
  }, []);
  useEffect(() => {
    setReader(null);
    setDrawn(null);
    setFailure(null);
    setBusy(true);
    if (!active) return;
    let live = true;
    let timedOut = false;
    // Read a new snapshot after each await; the effect may have been disposed in between.
    const isCurrent = (): boolean => live && !timedOut;
    const controller = new AbortController();
    request.current = controller;
    const cancel = schedule(() => {
      timedOut = true;
      controller.abort();
      current.current?.close();
      setFailure(new PdfPreviewError('timeout'));
      setBusy(false);
    }, PDF_LIMITS.deadlineMs);
    api
      .attachmentBytes(attachment.id, PDF_LIMITS.bytes, controller.signal)
      .then(async (bytes) => {
        if (!isCurrent() || controller.signal.aborted) return;
        const opened = await start(bytes, controller.signal);
        if (!isCurrent()) {
          opened.close();
          return;
        }
        current.current = opened;
        setReader(opened);
      })
      .catch((error: unknown) => {
        if (isCurrent()) {
          setFailure(error);
          setBusy(false);
        }
      })
      .finally(cancel);
    return (): void => {
      live = false;
      cancel();
      controller.abort();
      current.current?.close();
      current.current = null;
    };
  }, [active, api, attachment.id, attempt, schedule, start]);
  useEffect(() => {
    if (reader === null || width <= 0) return;
    let live = true;
    const isCurrent = (): boolean => live;
    setBusy(true);
    setDrawn(null);
    queue.current = queue.current.then(async (): Promise<void> => {
      if (!isCurrent() || canvas.current === null || text.current === null) return;
      try {
        const result = await reader.draw(
          page,
          width,
          zoom,
          window.devicePixelRatio || 1,
          canvas.current,
          text.current,
        );
        if (isCurrent()) {
          setDrawn(result);
          setBusy(false);
        }
      } catch (error) {
        if (isCurrent()) {
          reader.close();
          setFailure(error);
          setReader(null);
          setBusy(false);
        }
      }
    });
    return (): void => {
      live = false;
    };
  }, [reader, page, width, zoom]);

  const body = errorBody(failure);
  const hasText = drawn?.hasText ?? false;
  const ready = active && !busy && drawn !== null && failure === null;
  const disabled = !ready;
  return (
    <section
      id={id}
      aria-label={t('attachment.preview.label', { name: attachment.fileName })}
      className="min-w-0 rounded-xl border-hairline border-border-subtle bg-surface-100 shadow-card"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-1 border-b-hairline border-border-subtle p-2">
        <IconButton
          glyph="previous"
          label={t('pdf.previous')}
          disabled={disabled || page <= 1}
          onClick={() => {
            setBusy(true);
            setPage((value) => Math.max(1, value - 1));
          }}
        />
        <Select
          aria-label={t('pdf.choosePage')}
          value={page}
          disabled={disabled}
          onChange={(event) => {
            const wanted = Number(event.currentTarget.value);
            if (wanted !== page) {
              setBusy(true);
              setPage(wanted);
            }
          }}
        >
          {reader === null ? (
            <option value={1}>{t('pdf.choosePage')}</option>
          ) : (
            Array.from({ length: reader.pages }, (_, index) => (
              <option key={index} value={index + 1}>
                {index + 1}
              </option>
            ))
          )}
        </Select>
        <span className="font-mono text-caption text-ink-muted">
          {reader !== null && t('pdf.ofPages', { count: reader.pages })}
        </span>
        <IconButton
          glyph="next"
          label={t('pdf.next')}
          disabled={disabled || reader === null || page >= reader.pages}
          onClick={() => {
            setBusy(true);
            setPage((value) => Math.min(reader?.pages ?? 1, value + 1));
          }}
        />
        <Select
          aria-label={t('pdf.zoom')}
          value={zoom}
          disabled={disabled}
          onChange={(event) => {
            const wanted = Number(event.currentTarget.value);
            if (wanted !== zoom) {
              setBusy(true);
              setZoom(wanted);
            }
          }}
        >
          <option value={1}>{t('pdf.fit')}</option>
          {[1.5, 2, 3, PDF_LIMITS.zoomMax].map((factor) => (
            <option key={factor} value={factor}>
              {String(factor * 100)}%
            </option>
          ))}
        </Select>
        <a
          href={`/api/attachments/${attachment.id}`}
          download={attachment.fileName}
          aria-label={t('attachment.download', {
            name: attachment.fileName,
            size: format.bytes(attachment.sizeBytes),
          })}
          className="inline-flex h-control max-narrow:h-touch aspect-square items-center justify-center rounded-md text-ink-muted hover:bg-surface-200 hover:text-ink"
        >
          <Icon name="download" />
        </a>
        <IconButton
          glyph="close"
          label={t('attachment.preview.hide', { name: attachment.fileName })}
          onClick={onClose}
        />
      </div>
      <div
        ref={stage}
        role="region"
        className="relative h-attachment-preview min-w-0 overflow-auto bg-surface-200 scrollbar-thin"
        tabIndex={0}
        aria-label={t('pdf.pageLabel', { page })}
      >
        {failure !== null ? (
          body === 'pdf.password' || body === 'pdf.limited' ? (
            <p role="alert" className="p-4 text-body text-ink-muted">
              {t(body)}
            </p>
          ) : (
            <ErrorState
              title={t('attachment.preview.failed')}
              body={t(body)}
              retryLabel={t('common.retry')}
              onRetry={() => {
                setAttempt((value) => value + 1);
              }}
            />
          )
        ) : !active ? (
          <p role="status" className="p-4 text-body text-ink-muted">
            {t('pdf.paused')}
          </p>
        ) : busy ? (
          <LoadingStatus label={t('pdf.loading', { page })}>{null}</LoadingStatus>
        ) : null}
        <div
          className="relative"
          style={{
            width: drawn?.width,
            height: drawn?.height,
            visibility: ready ? 'visible' : 'hidden',
          }}
        >
          <canvas
            ref={canvas}
            role="img"
            aria-hidden={!ready || hasText}
            aria-label={t('pdf.pageLabel', { page })}
          />
          <div
            ref={text}
            data-pdf-text-layer
            role="document"
            aria-label={t('pdf.textLabel', { page })}
            aria-hidden={!ready || !hasText}
          />
        </div>
      </div>
      {ready && !hasText && (
        <p className="px-3 py-2 text-caption text-ink-muted">{t('pdf.scanned')}</p>
      )}
    </section>
  );
};

/** The connection belongs to the application; the reader's mechanics can be exercised independently. */
export const ConnectedPdfPreview = (
  props: Omit<Props, 'status' | 'start' | 'schedule'>,
): React.JSX.Element => <PdfPreview {...props} status={useConnectionStatus()} />;
