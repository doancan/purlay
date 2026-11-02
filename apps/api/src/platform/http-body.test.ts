/**
 * A reply read with a bound (`readCapped`): what a client of another service reads is never more than it
 * needs, whatever the service sends — a length said up front past the bound is not read at all, and a
 * body that keeps coming is cut off once the bound is passed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { aFloodingServer } from '../testing/hostile-servers';
import { readCapped } from './http-body';

const stops: (() => void)[] = [];
afterAll(() => {
  for (const stop of stops) stop();
});

const MB = 1024 * 1024;
/**
 * What may sit in the two ends' socket buffers once reading stops: Linux grows them under load up to
 * `tcp_rmem` (6 MB) and `tcp_wmem` (4 MB) by default, so 4 MB held only while the machine was idle and
 * failed beside another test file (D-228). Still a twentieth of the 300 the server would send.
 */
const SOCKET_BUFFERS = 16 * MB;

describe('a reply read with a bound', () => {
  test('a body within the bound is read whole, as text', async () => {
    expect(await readCapped(new Response('{"error":"x"}'), 8 * 1024)).toEqual({
      text: '{"error":"x"}',
    });
    expect(await readCapped(new Response('é'.repeat(10)), 20)).toEqual({ text: 'é'.repeat(10) });
  });

  test('one byte past the bound is too large', async () => {
    expect(await readCapped(new Response('a'.repeat(101)), 100)).toEqual({ tooLarge: true });
    expect(await readCapped(new Response('a'.repeat(100)), 100)).toEqual({
      text: 'a'.repeat(100),
    });
  });

  test('a body that keeps coming is cut off: what the server could write stays near the bound, not the body', async () => {
    const flooding = aFloodingServer(300 * MB);
    stops.push(flooding.stop);
    const response = await fetch(flooding.url);
    expect(await readCapped(response, 8 * 1024)).toEqual({ tooLarge: true });
    // Sockets buffer some — never the 300 the server would send.
    await Bun.sleep(100);
    expect(flooding.written()).toBeLessThan(SOCKET_BUFFERS);
  });

  test('a length said up front past the bound is refused before a byte of the body is asked for', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller): void => {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const response = new Response(body, { headers: { 'content-length': String(64 * 1024 + 1) } });
    expect(await readCapped(response, 64 * 1024)).toEqual({ tooLarge: true });
    expect(pulled).toBeLessThanOrEqual(1);
  });

  test('a length said up front past the bound, from a server, is refused without reading the body', async () => {
    const flooding = aFloodingServer(300 * MB, { declared: true });
    stops.push(flooding.stop);
    const response = await fetch(flooding.url);
    expect(await readCapped(response, 64 * 1024)).toEqual({ tooLarge: true });
    await Bun.sleep(100);
    expect(flooding.written()).toBeLessThan(SOCKET_BUFFERS);
  });
});
