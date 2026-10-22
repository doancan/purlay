/**
 * The API's idle memory budget (`PRD.md` §5, D-49, #73): a process that has started, migrated and
 * answered readiness, left alone a moment, must hold under 120 MiB. What is judged here is the
 * verdict and the words; the measurement is `budget-api.ts` itself, run by CI against a database.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import {
  BUDGET_BYTES,
  judge,
  main,
  measureIdleRss,
  measureOnAClone,
  onAClone,
  throwawayDatabaseProblem,
  type CloneWorld,
} from './budget-api';

const MIB = 1024 * 1024;

describe('the idle RSS verdict', () => {
  test('under the budget passes, and says how much room is left', () => {
    expect(judge(96 * MIB)).toEqual({
      ok: true,
      line: 'API idle RSS: 96.0 MiB of 120 MiB (24.0 MiB to spare)',
    });
  });

  test('at the budget, or over it, fails, and says by how much', () => {
    expect(judge(BUDGET_BYTES).ok).toBe(false);
    expect(judge(BUDGET_BYTES - 1).ok).toBe(true);
    expect(judge(130 * MIB)).toEqual({
      ok: false,
      line: 'API idle RSS: 130.0 MiB of 120 MiB — 10.0 MiB over (PRD.md §5)',
    });
  });
});

describe('the command', () => {
  const MIB_ = 1024 * 1024;
  test('with no database it says it measured nothing — and in CI refuses, rather than pass unmeasured', async () => {
    expect(await main({})).toEqual({
      line: "budget:api — DATABASE_URL is not set: the API's idle memory was NOT measured.",
      code: 0,
    });
    expect((await main({ CI: 'true' })).code).toBe(1);
    const unreachable = await main({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' });
    expect(unreachable.line).toContain('nothing answers at 127.0.0.1:1');
  });

  test('with one, it is the verdict on what was measured', async () => {
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data: () => undefined },
    });
    const url = `postgres://u:p@127.0.0.1:${String(listener.port)}/db`;
    expect(await main({ DATABASE_URL: url }, () => Promise.resolve(90 * MIB_))).toMatchObject({
      code: 0,
    });
    expect(await main({ DATABASE_URL: url }, () => Promise.resolve(121 * MIB_))).toMatchObject({
      code: 1,
    });
    listener.stop(true);
  });
});

describe('where the API is started', () => {
  test('only on a throwaway database: a clone of the test template, never the one a developer works in', () => {
    expect(throwawayDatabaseProblem('postgres://purlay:purlay@localhost:55432/purlay')).toContain(
      'not a throwaway database',
    );
    expect(throwawayDatabaseProblem('postgres://u:p@db.example:5432/purlay_template')).toContain(
      'not a throwaway database',
    );
    expect(
      throwawayDatabaseProblem('postgres://u:p@localhost/purlay_0123456789ab'),
    ).toBeUndefined();
    expect(
      throwawayDatabaseProblem('postgres://u:p@localhost/purlay_ci_0123456789ab'),
    ).toBeUndefined();
  });

  test('refuses the shared database before it starts anything or connects anywhere', async () => {
    const began = performance.now();
    const refusal = await measureIdleRss('postgres://purlay:purlay@127.0.0.1:1/purlay').then(
      () => 'measured',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(refusal).toContain('not a throwaway database');
    // Refused on the name alone: an API started there would take seconds to fail to become ready.
    expect(performance.now() - began).toBeLessThan(500);
  });
});

describe('a clone to start the API on, and what becomes of it', () => {
  const CLONE_URL = 'postgres://purlay:purlay@localhost:55432/purlay_clone_abc';
  const ran = (exitCode: number, out = ''): ReturnType<CloneWorld['spawn']> => ({
    exitCode,
    stdout: { toString: () => out },
  });

  /** A machine that makes a clone as asked, and records every command, signal handler and exit. */
  const aWorld = (
    over: { readonly clone?: ReturnType<CloneWorld['spawn']>; readonly drop?: number } = {},
  ): {
    readonly world: CloneWorld;
    readonly commands: string[][];
    readonly handlers: Map<string, () => void>;
    readonly exits: number[];
  } => {
    const commands: string[][] = [];
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    const world: CloneWorld = {
      spawn: (command) => {
        commands.push([...command]);
        return command[2] === 'clone'
          ? (over.clone ?? ran(0, `noise\n${CLONE_URL}\n`))
          : ran(over.drop ?? 0);
      },
      exit: (code) => {
        exits.push(code);
        throw new Error(`exit ${String(code)}`);
      },
      signals: {
        once: (signal, handler) => handlers.set(signal, handler),
        off: (signal, handler) => {
          if (handlers.get(signal) === handler) handlers.delete(signal);
        },
      },
    };
    return { world, commands, handlers, exits };
  };

  test('gives the body the clone’s address, returns its answer, and drops the clone by name', async () => {
    const { world, commands, handlers } = aWorld();
    const seen: string[] = [];
    const answer = await onAClone((url) => {
      seen.push(url);
      expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
      return Promise.resolve(42);
    }, world);
    expect(answer).toBe(42);
    expect(seen).toEqual([CLONE_URL]);
    expect(commands.map((command) => command.slice(2))).toEqual([
      ['clone'],
      ['drop', 'purlay_clone_abc'],
    ]);
    // It stops listening for signals once it is done: nothing is left to fire later.
    expect(handlers.size).toBe(0);
  });

  test('drops the clone when the body fails, and lets the failure through', async () => {
    const { world, commands } = aWorld();
    const failed = await onAClone(
      () => Promise.reject(new Error('the API did not start')),
      world,
    ).then(
      () => 'passed',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failed).toBe('the API did not start');
    expect(commands.at(-1)?.slice(2)).toEqual(['drop', 'purlay_clone_abc']);
  });

  test('does not run the body, and drops nothing, when no clone could be made', async () => {
    for (const clone of [ran(1, `${CLONE_URL}\n`), ran(0, '')]) {
      const { world, commands } = aWorld({ clone });
      let ranBody = false;
      const refused = await onAClone(() => {
        ranBody = true;
        return Promise.resolve(1);
      }, world).then(
        () => 'passed',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(refused).toBe('a clone of the test template could not be made to start the API on');
      expect(ranBody).toBe(false);
      expect(commands).toHaveLength(1);
    }
  });

  test('says a clone it could not drop, by name, instead of swallowing it', async () => {
    const { world } = aWorld({ drop: 1 });
    const said = spyOn(console, 'error').mockImplementation(() => undefined);
    await onAClone(() => Promise.resolve(1), world);
    expect(said).toHaveBeenCalledWith(
      'budget:api — could not drop the clone "purlay_clone_abc"; drop it by hand.',
    );
    said.mockRestore();
  });

  test('an interrupt drops the clone first and then leaves with the code the signal means', async () => {
    for (const [signal, code] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ] as const) {
      const { world, commands, handlers, exits } = aWorld();
      let reached: () => void = () => undefined;
      const running = onAClone(
        () =>
          new Promise<number>((resolve) => {
            reached = (): void => {
              resolve(1);
            };
          }),
        world,
      );
      const handler = handlers.get(signal);
      if (handler === undefined) throw new Error(`no handler for ${signal}`);
      expect(() => {
        handler();
      }).toThrow(`exit ${String(code)}`);
      expect(exits).toEqual([code]);
      expect(commands.at(-1)?.slice(2)).toEqual(['drop', 'purlay_clone_abc']);
      reached();
      await running;
    }
  });

  test('measures on the clone, not on the server it was asked about, and drops the clone after', async () => {
    const { world, commands } = aWorld();
    const measured: string[] = [];
    const rss = await measureOnAClone(
      'postgres://purlay:purlay@localhost:55432/purlay',
      world,
      (url) => {
        measured.push(url);
        return Promise.resolve(77 * 1024 * 1024);
      },
    );
    expect(rss).toBe(77 * 1024 * 1024);
    expect(measured).toEqual([CLONE_URL]);
    expect(commands.at(-1)?.slice(2)).toEqual(['drop', 'purlay_clone_abc']);
  });
});
