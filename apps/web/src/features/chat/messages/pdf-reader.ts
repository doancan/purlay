import './pdf-compat';
import { getDocument, PDFWorker, TextLayer, version } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type * as PdfLibrary from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Schedule } from '../../../realtime/connection';
import { browserSchedule } from '../../../realtime/socket';
import { PDF_LIMITS, PdfPreviewError, pageGeometry, type PageGeometry } from './pdf-limits';

/** The third-party SDK and browser worker/timers are the fault-injection seams, not the reader. */
export interface PdfPorts {
  readonly library: Pick<typeof PdfLibrary, 'getDocument' | 'PDFWorker' | 'TextLayer' | 'version'>;
  readonly newWorker: () => Worker;
  readonly schedule: Schedule;
}

const browser: PdfPorts = {
  library: { getDocument, PDFWorker, TextLayer, version },
  newWorker: () => new Worker(new URL('./pdf-worker.ts', import.meta.url), { type: 'module' }),
  schedule: browserSchedule,
};

// This SDK-internal packet is pinned and regression-tested: a refused image otherwise became a
// successful blank page through its public promises. See the measured PDF spike and upgrade cost.
const StreamFailure = Type.Object({ stream: Type.Literal(5) });
const ImageLimitFailure = Type.Object({
  stream: Type.Literal(5),
  reason: Type.Object({
    message: Type.Literal('Image exceeded maximum allowed size and was removed.'),
  }),
});
const Ready = Type.Object({ action: Type.Literal('ready') });
// Failed decodes take another silent public-success path in this pinned SDK: an Image object
// explicitly resolved to null. A valid empty page has no such image dependency.
const MissingImage = Type.Union([
  Type.Object({
    action: Type.Literal('obj'),
    data: Type.Tuple([Type.String(), Type.Unknown(), Type.Literal('Image'), Type.Null()]),
  }),
  Type.Object({
    action: Type.Literal('commonobj'),
    data: Type.Tuple([Type.String(), Type.Literal('Image'), Type.Null()]),
  }),
]);

export interface PdfReader {
  readonly pages: number;
  readonly draw: (
    page: number,
    width: number,
    zoom: number,
    ratio: number,
    canvas: HTMLCanvasElement,
    text: HTMLElement,
  ) => Promise<PageGeometry & { readonly hasText: boolean }>;
  readonly close: () => void;
}

export const openPdf = async (
  data: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
  ports: PdfPorts = browser,
): Promise<PdfReader> => {
  if (signal.aborted) throw new PdfPreviewError('cancelled');
  if (data.byteLength === 0 || data.byteLength > PDF_LIMITS.bytes)
    throw new PdfPreviewError('limits');
  const raw = ports.newWorker();
  const waiting = new Set<(error: Error) => void>();
  const timers = new Set<() => void>();
  let closed = false;
  let reason: Error = new PdfPreviewError('cancelled');
  let wrapped: PDFWorker | undefined;
  let task: PDFDocumentLoadingTask | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let text: HTMLElement | undefined;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const finish = (error: Error): void => {
    if (closed) return;
    closed = true;
    reason = error;
    for (const cancel of timers) cancel();
    timers.clear();
    for (const reject of waiting) reject(reason);
    waiting.clear();
    signal.removeEventListener('abort', abort);
    raw.removeEventListener('message', message);
    raw.removeEventListener('error', broken);
    raw.removeEventListener('messageerror', broken);
    if (canvas !== undefined) {
      canvas.width = 0;
      canvas.height = 0;
    }
    text?.replaceChildren();
    try {
      void task?.destroy().catch(() => {
        /* Closing already; the owned worker is terminated below. */
      });
    } catch {
      /* A failed SDK cleanup cannot prevent hard termination. */
    }
    try {
      wrapped?.destroy();
    } catch {
      /* The raw worker is still ours to terminate. */
    }
    raw.terminate();
  };
  const close = (): void => {
    finish(new PdfPreviewError('cancelled'));
  };
  const abort = (): void => {
    close();
  };
  const broken = (): void => {
    finish(new PdfPreviewError('unreadable'));
  };
  const message = ({ data: packet }: MessageEvent<unknown>): void => {
    if (Value.Check(Ready, packet)) ready();
    if (Value.Check(MissingImage, packet)) finish(new PdfPreviewError('unreadable'));
    if (Value.Check(StreamFailure, packet))
      finish(new PdfPreviewError(Value.Check(ImageLimitFailure, packet) ? 'limits' : 'unreadable'));
  };
  raw.addEventListener('message', message);
  raw.addEventListener('error', broken);
  raw.addEventListener('messageerror', broken);
  signal.addEventListener('abort', abort, { once: true });
  // Worker construction is an external seam and may synchronously abort the caller.
  const wasAborted = (): boolean => signal.aborted;
  if (wasAborted()) close();
  const wait = <T>(pending: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (closed) {
        reject(reason);
        return;
      }
      waiting.add(reject);
      pending.then(
        (value) => {
          waiting.delete(reject);
          resolve(value);
        },
        (error: unknown) => {
          waiting.delete(reject);
          reject(error instanceof Error ? error : new PdfPreviewError('unreadable'));
        },
      );
    });
  const bounded = async <T>(run: () => Promise<T>): Promise<T> => {
    if (closed) throw reason;
    const cancel = ports.schedule(() => {
      finish(new PdfPreviewError('timeout'));
    }, PDF_LIMITS.deadlineMs);
    timers.add(cancel);
    try {
      return await run();
    } catch (error) {
      const failure = error instanceof Error ? error : new PdfPreviewError('unreadable');
      finish(failure);
      throw failure;
    } finally {
      cancel();
      timers.delete(cancel);
    }
  };
  let document!: PDFDocumentProxy;
  await bounded(async (): Promise<void> => {
    await wait(started);
    wrapped = ports.library.PDFWorker.create({ port: raw });
    const base = `/assets/pdfjs-${ports.library.version}/`;
    task = ports.library.getDocument({
      data,
      worker: wrapped,
      maxImageSize: PDF_LIMITS.imagePixels,
      canvasMaxAreaInBytes: PDF_LIMITS.canvasPixels * 4,
      disableWorkerRendering: true,
      disableFontFace: true,
      useWasm: false,
      enableXfa: false,
      useSystemFonts: true,
      stopAtErrors: true,
      standardFontDataUrl: `${base}standard_fonts/`,
      cMapUrl: `${base}cmaps/`,
      cMapPacked: true,
      wasmUrl: `${base}wasm/`,
    });
    document = await wait(task.promise);
    if (
      !Number.isInteger(document.numPages) ||
      document.numPages < 1 ||
      document.numPages > PDF_LIMITS.pages
    )
      throw new PdfPreviewError('limits');
  });
  return {
    pages: document.numPages,
    close,
    draw: async (number, available, zoom, ratio, target, words) =>
      await bounded(async () => {
        if (!Number.isInteger(number) || number < 1 || number > document.numPages)
          throw new PdfPreviewError('limits');
        canvas = target;
        text = words;
        target.width = 0;
        target.height = 0;
        words.replaceChildren();
        const page = await wait(document.getPage(number));
        const base = page.getViewport({ scale: 1 });
        const geometry = pageGeometry(base.width, base.height, available, zoom, ratio);
        const viewport = page.getViewport({ scale: geometry.scale });
        target.width = geometry.pixelsWide;
        target.height = geometry.pixelsHigh;
        target.style.width = `${String(geometry.width)}px`;
        target.style.height = `${String(geometry.height)}px`;
        await wait(
          page.render({
            canvas: target,
            viewport,
            transform: [geometry.ratio, 0, 0, geometry.ratio, 0, 0],
          }).promise,
        );
        const source = page.streamTextContent() as ReadableStream<TextContent>;
        const reader = source.getReader();
        const content: TextContent = { items: [], styles: {}, lang: null };
        let chars = 0;
        try {
          for (;;) {
            const next = await wait(reader.read());
            if (next.done) break;
            for (const item of next.value.items) if ('str' in item) chars += item.str.length;
            if (
              chars > PDF_LIMITS.textChars ||
              content.items.length + next.value.items.length > PDF_LIMITS.textItems
            )
              throw new PdfPreviewError('limits');
            content.items.push(...next.value.items);
            content.styles = { ...content.styles, ...next.value.styles };
            content.lang ??= next.value.lang;
          }
        } finally {
          void reader.cancel().catch(() => {
            /* The session is already closing on a failure. */
          });
          reader.releaseLock();
        }
        const hasText = chars > 0;
        if (hasText) {
          words.style.setProperty('--total-scale-factor', String(viewport.scale));
          const layer = new ports.library.TextLayer({
            textContentSource: content,
            container: words,
            viewport,
          });
          try {
            await wait(layer.render());
          } finally {
            layer.cancel();
          }
        }
        await wait(document.cleanup());
        return { ...geometry, hasText };
      }),
  };
};
