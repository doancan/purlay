/**
 * The latency budget measured for real (#73): an API process, two signed-in sockets in one channel,
 * every message answered and delivered. The numbers are this machine's; what is held is that they
 * were taken — every message timed both ways — and are not absurd.
 */
import { describe, expect, test } from 'bun:test';
import { measureLatency } from './budget-latency';

describe('integration: measuring the latency budget', () => {
  test('times every message to its ACK and to the other socket', async () => {
    const latency = await measureLatency(5);
    expect(latency.messages).toBe(5);
    for (const value of [latency.ackP95Ms, latency.fanOutP95Ms]) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(5_000);
    }
  }, 120_000);
});
