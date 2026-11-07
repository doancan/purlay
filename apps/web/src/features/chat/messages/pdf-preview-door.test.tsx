import { act } from '@testing-library/react';
import { expect, test } from 'bun:test';
import type { Attachment } from '@purlay/types';
import { installDom } from '../../../testing/dom';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { expectFocusOn } from '../../../testing/focus';
import { fakeSchedule } from '../../../testing/fakes';
import { aMessage } from '../../../testing/fixtures';
import { mountChannel, page, settle } from '../../../testing/channel-harness';
import { PdfAttachment, type PdfDoorPorts } from './pdf-preview-door';
import type { ConnectedPdfPreview } from './pdf-preview';

installDom();
const file: Attachment = {
  id: '01995f7b-0000-7000-8000-0000000000a1',
  fileName: 'invoice.pdf',
  mimeType: 'application/pdf',
  kind: 'file',
  sizeBytes: 1000,
  width: null,
  height: null,
};
const View = ({
  attachment,
  id,
  onClose,
}: React.ComponentProps<typeof ConnectedPdfPreview>): React.JSX.Element => (
  <section id={id} aria-label={`Reader ${attachment.fileName}`}>
    <button type="button" onClick={onClose}>
      Close reader
    </button>
  </section>
);
const ports = (): PdfDoorPorts => ({
  load: () => Promise.resolve({ ConnectedPdfPreview: View }),
  schedule: fakeSchedule().schedule,
});

test('the loader is requested only on open, two PDFs are exclusive, and closing returns focus', async () => {
  let loads = 0;
  const backend = ports();
  const source: PdfDoorPorts = {
    ...backend,
    load: () => {
      loads += 1;
      return backend.load();
    },
  };
  const view = await renderApp(
    <>
      <PdfAttachment attachment={file} card={<a href="/file">Download invoice</a>} ports={source} />
      <PdfAttachment
        attachment={{ ...file, id: '01995f7b-0000-7000-8000-0000000000a2', fileName: 'policy.pdf' }}
        card={<a href="/policy">Download policy</a>}
        ports={source}
      />
    </>,
  );
  expect(loads).toBe(0);
  await person().click(view.getByRole('button', { name: 'Preview invoice.pdf' }));
  await view.findByRole('region', { name: 'Reader invoice.pdf' });
  expect(loads).toBe(1);
  await person().click(view.getByRole('button', { name: 'Preview policy.pdf' }));
  await view.findByRole('region', { name: 'Reader policy.pdf' });
  expect(view.queryByRole('region', { name: 'Reader invoice.pdf' }) === null).toBe(true);
  await person().click(view.getByRole('button', { name: 'Close reader' }));
  expectFocusOn(view.getByRole('button', { name: 'Preview policy.pdf' }));
  await person().click(view.getByRole('button', { name: 'Preview invoice.pdf' }));
  await view.findByRole('region', { name: 'Reader invoice.pdf' });
  await person().click(view.getByRole('button', { name: 'Hide the preview of invoice.pdf' }));
  expect(view.queryByRole('region', { name: 'Reader invoice.pdf' }) === null).toBe(true);
});

test('a module failure keeps the download and provides an explicit page reload', async () => {
  let reloaded = false;
  const descriptor = Object.getOwnPropertyDescriptor(window.location, 'reload');
  Object.defineProperty(window.location, 'reload', {
    configurable: true,
    value: (): void => {
      reloaded = true;
    },
  });
  try {
    const view = await renderApp(
      <PdfAttachment
        attachment={file}
        card={<a href="/file">Download invoice</a>}
        ports={{ ...ports(), load: () => Promise.reject(new Error('chunk missing')) }}
      />,
    );
    await person().click(view.getByRole('button', { name: 'Preview invoice.pdf' }));
    await view.findByRole('alert');
    expect(view.getByRole('link', { name: 'Download invoice' }).getAttribute('href')).toBe('/file');
    await person().click(view.getByRole('button', { name: 'Reload page' }));
    expect(reloaded).toBe(true);
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(window.location, 'reload');
    else Object.defineProperty(window.location, 'reload', descriptor);
  }
});

test('a hung module load times out and a late module never mounts', async () => {
  const timers = fakeSchedule();
  let answer!: (module: { readonly ConnectedPdfPreview: typeof View }) => void;
  const view = await renderApp(
    <PdfAttachment
      attachment={file}
      card={<a href="/file">Download invoice</a>}
      ports={{
        schedule: timers.schedule,
        load: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      }}
    />,
  );
  await person().click(view.getByRole('button', { name: 'Preview invoice.pdf' }));
  expect(timers.pending()).toBe(1);
  act(() => {
    timers.advance(15_000);
  });
  await view.findByRole('alert');
  await act(async () => {
    answer({ ConnectedPdfPreview: View });
    await Promise.resolve();
  });
  expect(view.queryByRole('region', { name: 'Reader invoice.pdf' }) === null).toBe(true);
});

test('the real lazy module is mounted under the signed-in connection and stays paused while disconnected', async () => {
  const view = await mountChannel({ messages: page([aMessage(1, { attachments: [file] })]) });
  await person().click(view.getByRole('button', { name: 'Preview invoice.pdf' }));
  await view.findByText(
    'The preview will be checked again when the connection and this tab are active.',
  );
  await settle();
  const trigger = view
    .getAllByRole('button', { name: 'Hide the preview of invoice.pdf' })
    .find((button) => button.hasAttribute('aria-expanded'));
  if (trigger === undefined) throw new Error('the PDF trigger is absent');
  await person().click(trigger);
  view.unmountAll();
});
