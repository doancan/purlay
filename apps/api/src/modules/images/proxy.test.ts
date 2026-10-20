/**
 * The image proxy's rules (#110): which addresses it will try, that every failure is the same refusal
 * with its reason in the log — the host, never the rest of the address — and that what it answers is
 * its own WebP, not the bytes it was sent.
 */
import { describe, expect, test } from 'bun:test';
import { AppError } from '../../platform/errors';
import { aRecordingLogger } from '../../testing/doubles';
import { heldDecodes, until } from '../../testing/decodes';
import { twoColourPng } from '../../testing/png';
import { readImage } from '../attachments/images';
import type { Fetched } from './fetch-external';
import { externalFetch, externalImageAddress, proxyImage } from './proxy';

const refusal = async (work: Promise<unknown>): Promise<string> => {
  const error = await work.then(
    () => null,
    (failure: unknown) => failure,
  );
  if (!(error instanceof AppError)) throw new Error(`expected a refusal, got ${String(error)}`);
  return error.body.code;
};

describe('the addresses the proxy will try', () => {
  test.each([
    ['https://images.example.com/a.png'],
    ['https://cdn.example.org/path/to/b.webp?size=2'],
  ])('%s', (raw) => {
    expect(externalImageAddress(raw)?.href).toBe(raw);
  });

  test.each([
    ['http://images.example.com/a.png', 'not https'],
    ['https://images.example.com:8443/a.png', 'another port'],
    ['https://user:secret@images.example.com/a.png', 'credentials'],
    ['https://127.0.0.1/a.png', 'an address literal'],
    ['https://[::1]/a.png', 'an IPv6 literal'],
    ['https://169.254.169.254/latest/meta-data', 'the metadata address, literally'],
    ['https://localhost/a.png', 'local'],
    ['https://grafana.localhost/a.png', 'local'],
    ['https://intranet/a.png', 'a bare name'],
    ['file:///etc/passwd', 'a file'],
    ['not a url', 'nothing'],
  ])('%s is refused (%s)', (raw) => {
    expect(externalImageAddress(raw)).toBeNull();
  });
});

describe('proxying an image', () => {
  const fetching = (result: Fetched) => (): Promise<Fetched> => Promise.resolve(result);

  test('a real image comes back as our WebP, not the bytes it was sent', async () => {
    const png = twoColourPng(8, 8);
    const bytes = await proxyImage(
      { fetch: fetching({ kind: 'bytes', bytes: png }), log: aRecordingLogger().log },
      'https://images.example.com/a.png',
    );
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WEBP');
  });

  test('every failure is one refusal, its reason logged with the host and never the address', async () => {
    const { log, lines } = aRecordingLogger();
    const secret = 'https://images.example.com/a.png?token=s3cret';
    const cases: [string, Fetched][] = [
      ['fetch failed', { kind: 'failed', reason: 'answered 302' }],
      ['not an image', { kind: 'bytes', bytes: new TextEncoder().encode('<svg/>') }],
      [
        'unreadable',
        {
          kind: 'bytes',
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]),
        },
      ],
    ];
    for (const [, result] of cases) {
      expect(await refusal(proxyImage({ fetch: fetching(result), log }, secret))).toBe(
        'IMAGE_NOT_AVAILABLE',
      );
    }
    expect(
      await refusal(
        proxyImage({ fetch: fetching({ kind: 'failed', reason: 'x' }), log }, 'http://x.example/'),
      ),
    ).toBe('IMAGE_NOT_AVAILABLE');
    expect(lines.map((line) => line['msg'])).toEqual([
      'external image not fetched',
      'external image not an image',
      'external image not readable',
      'external image refused',
    ]);
    expect(lines.slice(0, 3).map((line) => line['host'])).toEqual([
      'images.example.com',
      'images.example.com',
      'images.example.com',
    ]);
    expect(JSON.stringify(lines)).not.toContain('s3cret');
  });

  test('a fault that is ours, not the image’s, is thrown as it is', async () => {
    const broken = (): Promise<Fetched> => Promise.reject(new Error('the resolver is down'));
    const outcome = await proxyImage(
      { fetch: broken, log: aRecordingLogger().log },
      'https://images.example.com/a.png',
    ).then(
      () => 'served',
      (error: unknown) => (error instanceof Error ? error.message : 'other'),
    );
    expect(outcome).toBe('the resolver is down');
  });

  test('the production fetch checks addresses: a local name is refused before anything connects', async () => {
    expect(await externalFetch(new URL('https://localhost/a.png'))).toEqual({
      kind: 'failed',
      reason: 'refused an address that is not public',
    });
  });
});

describe('decoding what the proxy fetched', () => {
  test('one decode at a time and four waiting; the next is refused as not available, and an upload is not kept waiting behind them', async () => {
    const held = heldDecodes();
    const { log, lines } = aRecordingLogger();
    const png = twoColourPng(64, 64);
    const fetch = (): Promise<Fetched> => Promise.resolve({ kind: 'bytes', bytes: png });
    const asked = (): Promise<Uint8Array> =>
      proxyImage({ fetch, log, open: held.open }, 'https://images.example.com/a.png');
    const queued = Array.from({ length: 5 }, asked);
    await until(() => held.encoding() === 1);
    expect(await refusal(asked())).toBe('IMAGE_NOT_AVAILABLE');
    expect(lines.at(-1)).toMatchObject({
      msg: 'external image not decoded',
      host: 'images.example.com',
    });
    // The proxy holds one of the node's two decode slots at most: an upload's decode runs now, not
    // after every picture somebody's feed asked for.
    const upload = await Promise.race([
      readImage(png).then(() => 'decoded'),
      Bun.sleep(2_000).then(() => 'still waiting'),
    ]);
    expect(upload).toBe('decoded');
    expect(held.encoding()).toBe(1);
    held.release();
    expect((await Promise.all(queued)).length).toBe(5);
  });
});
