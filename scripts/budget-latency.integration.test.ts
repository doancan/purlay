/**
 * The door runs the real measurement (#73): with the database, the API's command is started with the
 * arguments given, and what it keeps is a measurement of every message.
 */
import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './budget-latency';

describe('integration: the latency budget, run through its door', () => {
  test('measures and keeps the result', async () => {
    const file = join(tmpdir(), `latency-${crypto.randomUUID()}.json`);
    const result = await main(process.env, ['--record', file]);
    expect(result).toEqual({ line: null, code: 0 });
    expect(await Bun.file(file).json()).toMatchObject({
      messages: 60,
      trials: [{ messages: 60 }, { messages: 60 }, { messages: 60 }],
    });
  }, 180_000);
});
