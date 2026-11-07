import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import type { Attachment } from '@purlay/types';
import { installDom } from '../../../testing/dom';
import { renderApp } from '../../../testing/render';
import { aSignedInApi } from '../../../testing/fixtures';
import { person } from '../../../testing/user';
import { settle } from '../../../testing/channel-harness';
import { fakeSchedule } from '../../../testing/fakes';
import { ApiError } from '../../../data/errors';
import { BinaryLimitError } from '../../../data/http-binary';
import type { ConnectionStatus } from '../../../realtime/connection';
import { PdfPreview } from './pdf-preview';
import type { PdfReader } from './pdf-reader';

installDom();
let originalWidth: PropertyDescriptor | undefined;
beforeEach(() => {
  originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 320,
  });
});
afterEach(() => {
  if (originalWidth === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  else Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalWidth);
  Reflect.deleteProperty(document, 'visibilityState');
});
const file: Attachment = {
  id: '01995f7b-0000-7000-8000-0000000000a1',
  fileName: 'Teklif.pdf',
  mimeType: 'application/pdf',
  kind: 'file',
  sizeBytes: 200,
  width: null,
  height: null,
};
const drawn = {
  width: 320,
  height: 450,
  scale: 1,
  ratio: 1,
  pixelsWide: 320,
  pixelsHigh: 450,
  hasText: true,
};
const fakeReader = (over: Partial<PdfReader> = {}): PdfReader => ({
  pages: 2,
  close: (): void => {
    /* The UI tests assert invocation separately; the reader tests prove disposal. */
  },
  draw: (page, _width, _zoom, _ratio, canvas, text): Promise<typeof drawn> => {
    canvas.width = 320;
    canvas.height = 450;
    text.textContent = `Invoice page ${String(page)} <script>plain words</script>`;
    return Promise.resolve(drawn);
  },
  ...over,
});

test('page selection, arrows, zoom, download and Escape work in the named reader', async () => {
  const asked: { page: number; zoom: number }[] = [];
  let closed = false;
  const source = fakeReader();
  const reader = fakeReader({
    draw: async (...args) => {
      asked.push({ page: args[0], zoom: args[2] });
      return await source.draw(...args);
    },
  });
  const view = await renderApp(
    <PdfPreview
      attachment={file}
      id="preview"
      status="open"
      onClose={() => {
        closed = true;
      }}
      start={() => Promise.resolve(reader)}
    />,
    { api: aSignedInApi({ attachmentBytes: () => Promise.resolve(new Uint8Array([1])) }) },
  );
  await view.findByRole('document', { name: 'Text on PDF page 1' });
  expect(view.getByRole('button', { name: 'Previous PDF page' }).hasAttribute('disabled')).toBe(
    true,
  );
  await person().click(view.getByRole('button', { name: 'Next PDF page' }));
  await view.findByRole('document', { name: 'Text on PDF page 2' });
  expect(view.getByRole('button', { name: 'Next PDF page' }).hasAttribute('disabled')).toBe(true);
  await person().click(view.getByRole('button', { name: 'Previous PDF page' }));
  await view.findByRole('document', { name: 'Text on PDF page 1' });
  await person().click(view.getByRole('button', { name: 'Next PDF page' }));
  await view.findByRole('document', { name: 'Text on PDF page 2' });
  await person().selectOptions(view.getByRole('combobox', { name: 'PDF zoom' }), '2');
  await settle();
  await person().selectOptions(view.getByRole('combobox', { name: 'PDF page' }), '1');
  await view.findByRole('document', { name: 'Text on PDF page 1' });
  expect(asked).toContainEqual({ page: 2, zoom: 2 });
  expect(view.container.querySelector('script')).toBeNull();
  expect(view.getByRole('link', { name: /Download Teklif.pdf/ }).hasAttribute('download')).toBe(
    true,
  );
  fireEvent.keyDown(view.getByRole('region', { name: 'Preview of Teklif.pdf' }), { key: 'Escape' });
  expect(closed).toBe(true);
});

test('a parser that completes after the reader was unmounted is disposed without painting', async () => {
  let answer!: (reader: PdfReader) => void;
  let started!: () => void;
  const parsing = new Promise<void>((resolve) => {
    started = resolve;
  });
  let closed = false;
  const view = await renderApp(
    <PdfPreview
      attachment={file}
      id="preview"
      status="open"
      onClose={() => {
        /* Not used. */
      }}
      start={() => {
        started();
        return new Promise((resolve) => {
          answer = resolve;
        });
      }}
    />,
    { api: aSignedInApi({ attachmentBytes: () => Promise.resolve(new Uint8Array([1])) }) },
  );
  await parsing;
  view.unmount();
  await act(async () => {
    answer(
      fakeReader({
        close: () => {
          closed = true;
        },
      }),
    );
    await Promise.resolve();
  });
  expect(closed).toBe(true);
});

test('an image-only document has a named image and an explicit text-recognition note', async () => {
  const view = await renderApp(
    <PdfPreview
      attachment={file}
      id="preview"
      status="open"
      onClose={() => {
        /* Not used. */
      }}
      start={() =>
        Promise.resolve(fakeReader({ draw: () => Promise.resolve({ ...drawn, hasText: false }) }))
      }
    />,
    { api: aSignedInApi({ attachmentBytes: () => Promise.resolve(new Uint8Array([1])) }) },
  );
  await view.findByRole('img', { name: 'PDF page 1' });
  expect(view.queryByRole('document') === null).toBe(true);
  await view.findByText(
    'This page is an image. Download the PDF to use your reader’s text recognition tools.',
  );
});

test('reselecting the current page or zoom never leaves the controls permanently busy', async () => {
  const view = await renderApp(
    <PdfPreview
      attachment={file}
      id="preview"
      status="open"
      onClose={() => {
        /* Not used. */
      }}
      start={() => Promise.resolve(fakeReader())}
    />,
    { api: aSignedInApi({ attachmentBytes: () => Promise.resolve(new Uint8Array([1])) }) },
  );
  await view.findByRole('document', { name: 'Text on PDF page 1' });
  fireEvent.change(view.getByRole('combobox', { name: 'PDF page' }), { target: { value: '1' } });
  await settle();
  expect(view.getByRole('combobox', { name: 'PDF page' }).hasAttribute('disabled')).toBe(false);
  fireEvent.change(view.getByRole('combobox', { name: 'PDF zoom' }), { target: { value: '1' } });
  await settle();
  expect(view.getByRole('combobox', { name: 'PDF zoom' }).hasAttribute('disabled')).toBe(false);
});

test('a late byte read after unmount never starts a parser', async () => {
  let answer: ((bytes: Uint8Array<ArrayBuffer>) => void) | undefined;
  let parsed = 0;
  let signal: AbortSignal | undefined;
  const view = await renderApp(
    <PdfPreview
      attachment={file}
      id="preview"
      status="open"
      onClose={() => {
        /* Not used in this disposal test. */
      }}
      start={() => {
        parsed += 1;
        return Promise.resolve(fakeReader());
      }}
    />,
    {
      api: aSignedInApi({
        attachmentBytes: (_id, _max, given) => {
          signal = given;
          return new Promise((resolve) => {
            answer = resolve;
          });
        },
      }),
    },
  );
  expect(signal?.aborted).toBe(false);
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    answer?.(new Uint8Array([1]));
    await Promise.resolve();
  });
  expect(parsed).toBe(0);
});

test('a failed draw closes the reader before presenting a retry', async () => {
  let closed = false;
  const view = await renderApp(
    <PdfPreview
      attachment={file}
      id="preview"
      status="open"
      onClose={() => {
        /* Not used. */
      }}
      start={() =>
        Promise.resolve(
          fakeReader({
            close: () => {
              closed = true;
            },
            draw: () => Promise.reject(new Error('broken render')),
          }),
        )
      }
    />,
    { api: aSignedInApi({ attachmentBytes: () => Promise.resolve(new Uint8Array([1])) }) },
  );
  await view.findByRole('alert');
  expect(closed).toBe(true);
  expect(view.queryByRole('document')).toBeNull();
});

test('network retry and reconnect always read fresh bytes; a later refusal never redraws cached words', async () => {
  let reads = 0;
  let change!: (status: ConnectionStatus) => void;
  const reader = fakeReader();
  const start = (): Promise<PdfReader> => Promise.resolve(reader);
  const Host = (): React.JSX.Element => {
    const [status, setStatus] = useState<ConnectionStatus>('open');
    change = setStatus;
    return (
      <PdfPreview
        attachment={file}
        id="preview"
        status={status}
        onClose={() => {
          /* Not used. */
        }}
        start={start}
      />
    );
  };
  const view = await renderApp(<Host />, {
    api: aSignedInApi({
      attachmentBytes: () => {
        reads += 1;
        return reads === 1
          ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
          : reads === 2
            ? Promise.resolve(new Uint8Array([1]))
            : Promise.reject(new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'gone'));
      },
    }),
  });
  await view.findByRole('alert');
  await person().click(view.getByRole('button', { name: 'Retry' }));
  await view.findByRole('document', { name: 'Text on PDF page 1' });
  act(() => {
    change('waiting');
  });
  expect(view.queryByRole('document')).toBeNull();
  expect(reads).toBe(2);
  act(() => {
    change('open');
  });
  await view.findByText('This file is no longer available, or you no longer have access.');
  expect(view.queryByRole('document')).toBeNull();
  expect(reads).toBe(3);
});

test('backgrounding discards the reader, and returning revalidates it', async () => {
  let reads = 0;
  let closes = 0;
  const reader = fakeReader({
    close: () => {
      closes += 1;
    },
  });
  const view = await renderApp(
    <PdfPreview
      attachment={file}
      id="preview"
      status="open"
      onClose={() => {
        /* Not used. */
      }}
      start={() => Promise.resolve(reader)}
    />,
    {
      api: aSignedInApi({
        attachmentBytes: () => {
          reads += 1;
          return Promise.resolve(new Uint8Array([1]));
        },
      }),
    },
  );
  await view.findByRole('document', { name: 'Text on PDF page 1' });
  act(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(closes).toBeGreaterThan(0);
  expect(view.queryByRole('document')).toBeNull();
  act(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await view.findByRole('document', { name: 'Text on PDF page 1' });
  expect(reads).toBe(2);
});

test('an unanswered download is aborted at its deadline and remains downloadable', async () => {
  const timers = fakeSchedule();
  let signal: AbortSignal | undefined;
  const view = await renderApp(
    <PdfPreview
      attachment={file}
      id="preview"
      status="open"
      schedule={timers.schedule}
      onClose={() => {
        /* Not used. */
      }}
    />,
    {
      api: aSignedInApi({
        attachmentBytes: (_id, _max, given) => {
          signal = given;
          return new Promise(() => {
            /* The caller must bound this unanswered transport. */
          });
        },
      }),
    },
  );
  act(() => {
    timers.advance(15_000);
  });
  expect(signal?.aborted).toBe(true);
  await view.findByText('The document took too long to open. Try again, or download it.');
  expect(view.getByRole('link', { name: /Download Teklif.pdf/ }).hasAttribute('download')).toBe(
    true,
  );
});

test.each([
  [new BinaryLimitError(), 'This document exceeds the preview limits. Download it to read it.'],
  [
    Object.assign(new Error('password'), { name: 'PasswordException' }),
    'This PDF needs a password. Download it to open it in your PDF reader.',
  ],
] as const)(
  'a permanent refusal stays explicit and keeps the original download',
  async (error, message) => {
    const view = await renderApp(
      <PdfPreview
        attachment={file}
        id="preview"
        status="open"
        onClose={() => {
          /* Not used. */
        }}
      />,
      { api: aSignedInApi({ attachmentBytes: () => Promise.reject(error) }) },
    );
    await view.findByText(message);
    expect(view.queryByRole('document')).toBeNull();
    expect(view.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(view.getByRole('link', { name: /Download Teklif.pdf/ }).hasAttribute('download')).toBe(
      true,
    );
  },
);
