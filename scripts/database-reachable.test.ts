/**
 * Whether a database answers (#73): something listening is reachable; a port nobody listens on is
 * not, and says so within its second rather than hanging.
 */
import { describe, expect, test } from 'bun:test';
import { reachable } from './database-reachable';

describe('a database address', () => {
  test('is reachable when something listens there, and not when nothing does', async () => {
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data: () => undefined },
    });
    expect(await reachable(`postgres://u:p@127.0.0.1:${String(listener.port)}/db`)).toBe(true);
    const closed = listener.port;
    listener.stop(true);
    expect(await reachable(`postgres://u:p@127.0.0.1:${String(closed)}/db`)).toBe(false);
  });

  test('an address that never answers is not reachable after its second, rather than a hang', async () => {
    // TEST-NET-1 (RFC 5737): routed nowhere, so the connection neither succeeds nor is refused.
    const started = Date.now();
    expect(await reachable('postgres://u:p@192.0.2.1:5432/db')).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
