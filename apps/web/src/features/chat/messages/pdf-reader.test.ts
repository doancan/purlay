import { expect, test } from 'bun:test';
import { installDom } from '../../../testing/dom';
import { fakeSchedule } from '../../../testing/fakes';
import { openPdf, type PdfPorts } from './pdf-reader';
import { PDF_LIMITS } from './pdf-limits';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';

installDom();

/** The external SDK seam, not a replacement of the reader's cancellation/boundary logic. */
const sdkWorld = (
  options: {
    readonly pages?: number;
    readonly content?: TextContent;
    readonly render?: () => Promise<void>;
    readonly cleanupThrows?: boolean;
    readonly cleanupRejects?: boolean;
    readonly stream?: () => ReadableStream<TextContent>;
    readonly taskRejects?: Error;
  } = {},
): {
  readonly ports: PdfPorts;
  readonly raw: EventTarget;
  readonly timers: ReturnType<typeof fakeSchedule>;
  readonly seen: {
    terminated: number;
    destroyed: number;
    wrapped: number;
    cancelledText: number;
    documentCleaned: number;
    pageAsked: number[];
    documentOptions: unknown;
  };
} => {
  const timers = fakeSchedule();
  const seen = {
    terminated: 0,
    destroyed: 0,
    wrapped: 0,
    cancelledText: 0,
    documentCleaned: 0,
    pageAsked: [] as number[],
    documentOptions: undefined as unknown,
  };
  const raw = Object.assign(new EventTarget(), {
    terminate: (): void => {
      seen.terminated += 1;
    },
  });
  const content = options.content ?? {
    items: [
      {
        str: 'Görkem <script> words',
        dir: 'ltr',
        transform: [1, 0, 0, 1, 0, 0],
        width: 100,
        height: 12,
        fontName: 'free-font',
        hasEOL: true,
      },
    ],
    styles: {},
    lang: 'tr',
  };
  const page = {
    getViewport: ({
      scale,
    }: {
      readonly scale: number;
    }): { width: number; height: number; scale: number } => ({
      width: 600 * scale,
      height: 900 * scale,
      scale,
    }),
    render: (): { promise: Promise<void> } => ({
      promise: options.render?.() ?? Promise.resolve(),
    }),
    streamTextContent: (): ReadableStream<TextContent> =>
      options.stream?.() ??
      new ReadableStream<TextContent>({
        start(controller): void {
          controller.enqueue(content);
          controller.close();
        },
      }),
  };
  const doc = {
    numPages: options.pages ?? 2,
    cleanup: (): Promise<void> => {
      seen.documentCleaned += 1;
      return Promise.resolve();
    },
    getPage: (number: number): Promise<typeof page> => {
      seen.pageAsked.push(number);
      return Promise.resolve(page);
    },
  };
  class Layer {
    private readonly container: HTMLElement;
    constructor({ container }: { readonly container: HTMLElement }) {
      this.container = container;
    }
    render(): Promise<void> {
      this.container.textContent = 'Görkem <script> words';
      return Promise.resolve();
    }
    cancel(): void {
      seen.cancelledText += 1;
    }
  }
  const library = {
    version: 'test-pinned-version',
    PDFWorker: {
      create: ({ port }: { readonly port: Worker }) => {
        expect(port).toBe(raw as unknown as Worker);
        return {
          destroy: (): void => {
            seen.wrapped += 1;
            if (options.cleanupThrows === true) throw new Error('wrapper cleanup failed');
          },
        };
      },
    },
    TextLayer: Layer,
    getDocument: (given: unknown) => {
      seen.documentOptions = given;
      return {
        promise:
          options.taskRejects === undefined
            ? Promise.resolve(doc)
            : Promise.reject(options.taskRejects),
        destroy: (): Promise<void> => {
          seen.destroyed += 1;
          if (options.cleanupThrows === true) throw new Error('task cleanup failed');
          return options.cleanupRejects === true
            ? Promise.reject(new Error('asynchronous cleanup failed'))
            : Promise.resolve();
        },
      };
    },
  } as unknown as PdfPorts['library'];
  const ports: PdfPorts = {
    library,
    schedule: timers.schedule,
    newWorker: () => {
      queueMicrotask(() => {
        raw.dispatchEvent(
          new MessageEvent('message', {
            data: { action: 'ready', sourceName: 'worker', targetName: 'main' },
          }),
        );
      });
      return raw as unknown as Worker;
    },
  };
  return { ports, raw, timers, seen };
};

const targets = (): { canvas: HTMLCanvasElement; words: HTMLDivElement } => ({
  canvas: document.createElement('canvas'),
  words: document.createElement('div'),
});

test('an already cancelled preview never starts a worker', async () => {
  const controller = new AbortController();
  controller.abort();
  let workers = 0;
  const ports = {
    newWorker: () => {
      workers += 1;
      throw new Error('must not start');
    },
  } as unknown as PdfPorts;
  const error = await openPdf(new Uint8Array([1]), controller.signal, ports).catch(
    (failure: unknown) => failure,
  );
  expect(error).toMatchObject({ kind: 'cancelled' });
  expect(workers).toBe(0);
});

test('a worker that never becomes ready is terminated at the deadline', async () => {
  const schedule = fakeSchedule();
  let terminated = false;
  const worker = Object.assign(new EventTarget(), {
    terminate: (): void => {
      terminated = true;
    },
  });
  const ports = {
    newWorker: () => worker as unknown as Worker,
    schedule: schedule.schedule,
  } as unknown as PdfPorts;
  const result = openPdf(new Uint8Array([1]), new AbortController().signal, ports).catch(
    (failure: unknown) => failure,
  );
  schedule.advance(15_000);
  expect(await result).toMatchObject({ kind: 'timeout' });
  expect(terminated).toBe(true);
});

test('the actual reader enforces SDK options, page geometry, text rendering and idempotent cleanup', async () => {
  const world = sdkWorld();
  const controller = new AbortController();
  const reader = await openPdf(new Uint8Array([1]), controller.signal, world.ports);
  const { canvas, words } = targets();
  expect(reader.pages).toBe(2);
  expect(world.seen.documentOptions).toMatchObject({
    maxImageSize: PDF_LIMITS.imagePixels,
    useWasm: false,
    enableXfa: false,
    disableFontFace: true,
    stopAtErrors: true,
    disableWorkerRendering: true,
    cMapUrl: '/assets/pdfjs-test-pinned-version/cmaps/',
  });
  const first = await reader.draw(1, 320, 1, 2, canvas, words);
  expect(first.hasText).toBe(true);
  expect(canvas.width * canvas.height).toBeLessThanOrEqual(PDF_LIMITS.canvasPixels);
  expect(words.textContent).toContain('Görkem');
  expect(words.querySelector('script')).toBeNull();
  expect(world.seen.documentCleaned).toBe(1);
  reader.close();
  reader.close();
  controller.abort();
  expect(world.seen.terminated).toBe(1);
  expect(world.seen.destroyed).toBe(1);
  expect(world.seen.wrapped).toBe(1);
  expect(canvas.width).toBe(0);
  expect(words.textContent).toBe('');
  expect(world.timers.pending()).toBe(0);
  const error = await reader.draw(2, 320, 1, 1, canvas, words).catch((failure: unknown) => failure);
  expect(error).toMatchObject({ kind: 'cancelled' });
  expect(world.seen.pageAsked).toEqual([1]);
});

test('a raw SDK stream error rejects a nominally successful render instead of accepting a blank page', async () => {
  const world = sdkWorld({
    render: () => {
      world.raw.dispatchEvent(
        new MessageEvent('message', {
          data: {
            stream: 5,
            reason: {
              name: 'UnknownErrorException',
              message: 'Image exceeded maximum allowed size and was removed.',
            },
          },
        }),
      );
      return Promise.resolve();
    },
  });
  const reader = await openPdf(new Uint8Array([1]), new AbortController().signal, world.ports);
  const { canvas, words } = targets();
  const error = await reader.draw(1, 320, 1, 1, canvas, words).catch((failure: unknown) => failure);
  expect(error).toMatchObject({ kind: 'limits' });
  expect(world.seen.terminated).toBe(1);
  expect(canvas.width).toBe(0);
});

test.each(['error', 'messageerror'])(
  'a worker %s closes an active document and clears its page',
  async (kind) => {
    const world = sdkWorld();
    const reader = await openPdf(new Uint8Array([1]), new AbortController().signal, world.ports);
    const { canvas, words } = targets();
    await reader.draw(1, 320, 1, 1, canvas, words);
    world.raw.dispatchEvent(new Event(kind));
    expect(canvas.width).toBe(0);
    expect(world.seen.terminated).toBe(1);
    expect(
      await reader.draw(1, 320, 1, 1, canvas, words).catch((failure: unknown) => failure),
    ).toMatchObject({ kind: 'unreadable' });
  },
);

test('aborting an in-flight render ends the wait and terminates even when SDK cleanup throws', async () => {
  let entered: (() => void) | undefined;
  const drawing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const world = sdkWorld({
    cleanupThrows: true,
    render: () => {
      entered?.();
      return new Promise(() => {
        /* Cancellation must bound this external operation. */
      });
    },
  });
  const controller = new AbortController();
  const reader = await openPdf(new Uint8Array([1]), controller.signal, world.ports);
  const { canvas, words } = targets();
  const result = reader.draw(1, 320, 1, 1, canvas, words).catch((failure: unknown) => failure);
  await drawing;
  controller.abort();
  expect(await result).toMatchObject({ kind: 'cancelled' });
  expect(world.seen.terminated).toBe(1);
  expect(canvas.width).toBe(0);
});

test('a rendering deadline is a visible timeout, not an unbounded library promise', async () => {
  let entered: (() => void) | undefined;
  const drawing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const world = sdkWorld({
    render: () => {
      entered?.();
      return new Promise(() => {
        /* Deliberately stalled SDK seam. */
      });
    },
  });
  const reader = await openPdf(new Uint8Array([1]), new AbortController().signal, world.ports);
  const { canvas, words } = targets();
  const result = reader.draw(1, 320, 1, 1, canvas, words).catch((failure: unknown) => failure);
  await drawing;
  world.timers.advance(PDF_LIMITS.deadlineMs);
  expect(await result).toMatchObject({ kind: 'timeout' });
  expect(world.seen.terminated).toBe(1);
});

test.each([0, PDF_LIMITS.pages + 1, Number.NaN])(
  'a page count outside the reader bound is refused: %s',
  async (pages) => {
    const world = sdkWorld({ pages });
    expect(
      await openPdf(new Uint8Array([1]), new AbortController().signal, world.ports).catch(
        (failure: unknown) => failure,
      ),
    ).toMatchObject({ kind: 'limits' });
    expect(world.seen.terminated).toBe(1);
  },
);

test('empty or oversized bytes never allocate a worker', async () => {
  const world = sdkWorld();
  for (const data of [new Uint8Array(), new Uint8Array(PDF_LIMITS.bytes + 1)]) {
    expect(
      await openPdf(data, new AbortController().signal, world.ports).catch(
        (failure: unknown) => failure,
      ),
    ).toMatchObject({ kind: 'limits' });
  }
  expect(world.timers.pending()).toBe(0);
  expect(world.seen.documentOptions).toBeUndefined();
});

test.each([0, 3, 1.5])('a page outside this document never reaches the SDK: %s', async (number) => {
  const world = sdkWorld();
  const reader = await openPdf(new Uint8Array([1]), new AbortController().signal, world.ports);
  const { canvas, words } = targets();
  expect(
    await reader.draw(number, 320, 1, 1, canvas, words).catch((failure: unknown) => failure),
  ).toMatchObject({ kind: 'limits' });
  expect(world.seen.pageAsked).toEqual([]);
});

test.each([PDF_LIMITS.textChars + 1, PDF_LIMITS.textItems + 1])(
  'text extraction bounds are checked before adding DOM: %s',
  async (size) => {
    const content: TextContent =
      size > PDF_LIMITS.textChars
        ? {
            items: [
              {
                str: 'a'.repeat(size),
                dir: 'ltr',
                transform: [],
                width: 1,
                height: 1,
                fontName: '',
                hasEOL: false,
              },
            ],
            styles: {},
            lang: null,
          }
        : {
            items: Array.from({ length: size }, () => ({ type: 'beginMarkedContent', id: 'x' })),
            styles: {},
            lang: null,
          };
    const world = sdkWorld({ content });
    const reader = await openPdf(new Uint8Array([1]), new AbortController().signal, world.ports);
    const { canvas, words } = targets();
    expect(
      await reader.draw(1, 320, 1, 1, canvas, words).catch((failure: unknown) => failure),
    ).toMatchObject({ kind: 'limits' });
    expect(words.childNodes.length).toBe(0);
    expect(world.seen.terminated).toBe(1);
  },
);

test('an image-only page is explicit about having no extracted text', async () => {
  const world = sdkWorld({ content: { items: [], styles: {}, lang: null } });
  const reader = await openPdf(new Uint8Array([1]), new AbortController().signal, world.ports);
  const { canvas, words } = targets();
  expect((await reader.draw(1, 320, 1, 1, canvas, words)).hasText).toBe(false);
  expect(world.seen.cancelledText).toBe(0);
  reader.close();
});

test('a library refusal retains its actual reason and still disposes the worker', async () => {
  const password = Object.assign(new Error('needs password'), { name: 'PasswordException' });
  const world = sdkWorld({ taskRejects: password });
  expect(
    await openPdf(new Uint8Array([1]), new AbortController().signal, world.ports).catch(
      (failure: unknown) => failure,
    ),
  ).toBe(password);
  expect(world.seen.terminated).toBe(1);
});

test('an SDK error packet with an unfamiliar reason is an unreadable page, never a blank success', async () => {
  const world = sdkWorld({
    render: () => {
      world.raw.dispatchEvent(
        new MessageEvent('message', { data: { stream: 5, reason: 'unfamiliar error' } }),
      );
      return Promise.resolve();
    },
  });
  const reader = await openPdf(new Uint8Array([1]), new AbortController().signal, world.ports);
  const { canvas, words } = targets();
  expect(
    await reader.draw(1, 320, 1, 1, canvas, words).catch((failure: unknown) => failure),
  ).toMatchObject({ kind: 'unreadable' });
});

test.each([
  { action: 'obj', data: ['img_1', 0, 'Image', null] },
  { action: 'commonobj', data: ['img_1', 'Image', null] },
])('a missing decoded image rejects a nominally successful public render', async (packet) => {
  const world = sdkWorld({
    render: () => {
      world.raw.dispatchEvent(new MessageEvent('message', { data: packet }));
      return Promise.resolve();
    },
  });
  const reader = await openPdf(new Uint8Array([1]), new AbortController().signal, world.ports);
  const { canvas, words } = targets();
  expect(
    await reader.draw(1, 320, 1, 1, canvas, words).catch((failure: unknown) => failure),
  ).toMatchObject({ kind: 'unreadable' });
  expect(world.seen.terminated).toBe(1);
  expect(canvas.width).toBe(0);
});

test('a rejection during SDK cleanup is contained and does not replace cancellation', async () => {
  const world = sdkWorld({ cleanupRejects: true });
  const controller = new AbortController();
  const reader = await openPdf(new Uint8Array([1]), controller.signal, world.ports);
  reader.close();
  expect(world.seen.terminated).toBe(1);
  const { canvas, words } = targets();
  expect(
    await reader.draw(1, 320, 1, 1, canvas, words).catch((failure: unknown) => failure),
  ).toMatchObject({ kind: 'cancelled' });
});

test('aborting a text stream remains bounded even when cancelling that stream rejects', async () => {
  let reading!: () => void;
  const began = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const world = sdkWorld({
    stream: () =>
      new ReadableStream<TextContent>(
        {
          pull: (): void => {
            reading();
          },
          cancel: (): Promise<void> => Promise.reject(new Error('stream cancellation failed')),
        },
        { highWaterMark: 0 },
      ),
  });
  const controller = new AbortController();
  const reader = await openPdf(new Uint8Array([1]), controller.signal, world.ports);
  const { canvas, words } = targets();
  const result = reader.draw(1, 320, 1, 1, canvas, words).catch((failure: unknown) => failure);
  await began;
  controller.abort();
  expect(await result).toMatchObject({ kind: 'cancelled' });
  expect(world.seen.terminated).toBe(1);
});

test('a caller aborted by worker construction still terminates that just-created worker', async () => {
  const world = sdkWorld();
  const controller = new AbortController();
  const ports = {
    ...world.ports,
    newWorker: (): Worker => {
      controller.abort();
      return world.raw as unknown as Worker;
    },
  };
  expect(
    await openPdf(new Uint8Array([1]), controller.signal, ports).catch(
      (failure: unknown) => failure,
    ),
  ).toMatchObject({ kind: 'cancelled' });
  expect(world.seen.terminated).toBe(1);
});

test('the browser default starts a module worker at the owned source and handles a real SDK transport failure', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  let terminated = false;
  let address = '';
  class BrokenTransport extends EventTarget {
    constructor(url: URL, options: WorkerOptions) {
      super();
      address = url.pathname;
      expect(options.type).toBe('module');
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent('message', { data: { action: 'ready' } }));
      });
    }
    terminate(): void {
      terminated = true;
    }
    postMessage(): never {
      throw new Error('worker transport failed');
    }
  }
  try {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: BrokenTransport });
    const error = await openPdf(new Uint8Array([1]), new AbortController().signal).catch(
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ message: 'worker transport failed' });
    expect(address.endsWith('/pdf-worker.ts')).toBe(true);
    expect(terminated).toBe(true);
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'Worker');
    else Object.defineProperty(globalThis, 'Worker', original);
  }
});
