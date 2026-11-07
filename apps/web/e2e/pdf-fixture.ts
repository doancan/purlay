/** Self-authored PDFs, with a standard font and no third-party document/font redistribution. */
import { deflateSync } from 'node:zlib';

const assemble = (objects: readonly Buffer[]): Buffer => {
  const chunks = [Buffer.from('%PDF-1.7\n')];
  const offsets = [0];
  let length = chunks[0]?.length ?? 0;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${String(index + 1)} 0 obj\n`),
      object,
      Buffer.from('\nendobj\n'),
    ]);
    chunks.push(chunk);
    length += chunk.length;
  }
  const start = length;
  chunks.push(
    Buffer.from(
      `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join(
          '',
        )}trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(start)}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
};
const stream = (bytes: Buffer, dictionary = ''): Buffer =>
  Buffer.concat([
    Buffer.from(`<< /Length ${String(bytes.length)} ${dictionary} >>\nstream\n`),
    bytes,
    Buffer.from('\nendstream'),
  ]);
const object = (value: string): Buffer => Buffer.from(value);

/** Two pages with text, a vector rectangle and an embedded script that must never execute. */
export const invoicePdf = (): Buffer =>
  assemble([
    object('<< /Type /Catalog /Pages 2 0 R /OpenAction 8 0 R >>'),
    object('<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'),
    object(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    ),
    stream(
      object(
        'BT /F1 18 Tf 40 740 Td (Quotation Purlay) Tj 0 -32 Td (Reference 1222 - Total 12345.67) Tj ET 0.1 0.3 0.5 rg 40 560 400 90 re f',
      ),
    ),
    object(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    ),
    stream(
      object('BT /F1 18 Tf 40 740 Td (Delivery details) Tj 0 -32 Td (Second page complete.) Tj ET'),
    ),
    object('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    object('<< /S /JavaScript /JS (globalThis.PURLAY_BAD_PDF=true;) >>'),
  ]);

/** A consistent, compressible RGB image one pixel-side beyond the reader image cap, not an OOM probe. */
export const overLimitImagePdf = (): Buffer => {
  const side = 4097;
  const pixels = Buffer.alloc(side * side * 3);
  for (let at = 0; at < pixels.length; at += 3) {
    pixels[at] = 240;
    pixels[at + 1] = 32;
    pixels[at + 2] = 32;
  }
  return assemble([
    object('<< /Type /Catalog /Pages 2 0 R >>'),
    object('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    object(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im 5 0 R >> >> /Contents 4 0 R >>',
    ),
    stream(object('q 200 0 0 200 0 0 cm /Im Do Q')),
    stream(
      deflateSync(pixels),
      `/Type /XObject /Subtype /Image /Width ${String(side)} /Height ${String(side)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
    ),
  ]);
};
