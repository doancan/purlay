import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { main, report } from './budget-latency';

describe('the latency budget’s door', () => {
  test('no database: a banner locally, a refusal in CI, and nothing run', async () => {
    let ran = false;
    const run = async (): Promise<number> => {
      ran = true;
      return await Promise.resolve(0);
    };
    expect(await main({}, [], run)).toEqual({
      line: 'budget:latency — DATABASE_URL is not set: the latency budgets were NOT measured.',
      code: 0,
    });
    expect((await main({ CI: 'true' }, [], run)).code).toBe(1);
    expect(ran).toBe(false);
  });

  test('a database that answers: the measurement runs with the arguments, and its code is the answer', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const given: (readonly string[])[] = [];
    const result = await main(
      { DATABASE_URL: `postgres://x:y@127.0.0.1:${String(address.port)}/z` },
      ['--record', 'kept.json'],
      async (args) => {
        given.push(args);
        return await Promise.resolve(1);
      },
    );
    server.close();
    expect(given).toEqual([['--record', 'kept.json']]);
    expect(result).toEqual({ line: null, code: 1 });
  });

  test('what it says goes out, or to the error stream when it fails; a run that says nothing prints nothing', () => {
    const said: string[] = [];
    const print = {
      out: (line: string): void => {
        said.push(`out: ${line}`);
      },
      error: (line: string): void => {
        said.push(`error: ${line}`);
      },
    };
    expect(report({ line: 'measured nothing', code: 0 }, print)).toBe(0);
    expect(report({ line: 'refused', code: 1 }, print)).toBe(1);
    expect(report({ line: null, code: 1 }, print)).toBe(1);
    expect(said).toEqual(['out: measured nothing', 'error: refused']);
  });
});
