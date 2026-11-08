/**
 * The check that nodes of a cluster run one module set (D-250): a mismatch is said once and never stops a
 * node, it is said again as over when the nodes agree, and a Redis that is away is not a mismatch. The script
 * that keeps the shared record is held against a real Redis (`module-set.redis.integration.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { redisNames } from '../platform/redis-names';
import { aRecordingLogger } from '../testing/doubles';
import { aFakeLink, type FakeLink } from '../testing/redis';
import type { EntitlementMode } from '../platform/module-kit/entitlement';
import type { Timers } from './hub';
import {
  ANNOUNCE_RETRY_MS,
  moduleSetOf,
  NODE_TTL_MS,
  watchModuleSet,
  type ModuleSetWatch,
} from './module-set';

const names = redisNames();

/** Timers that run when the test says: the renewal is a turn of the loop, not a wait. */
const manualTimers = (): {
  timers: Timers;
  tick: () => Promise<void>;
  pending: () => number;
  /** The wait each timer was set for, in the order they were set. */
  delays: number[];
} => {
  const waiting = new Map<number, () => void>();
  const delays: number[] = [];
  let id = 0;
  return {
    delays,
    timers: {
      set: (callback, ms): number => {
        delays.push(ms);
        id += 1;
        waiting.set(id, callback);
        return id;
      },
      clear: (handle): void => {
        waiting.delete(handle as number);
      },
    },
    tick: async (): Promise<void> => {
      for (const [handle, callback] of [...waiting]) {
        waiting.delete(handle);
        callback();
      }
      await Bun.sleep(0);
    },
    pending: (): number => waiting.size,
  };
};

const settle = async (): Promise<void> => {
  await Bun.sleep(0);
};

const aWatch = (
  answers: () => unknown,
  set = 'chat',
  mode: EntitlementMode = 'open',
): {
  link: FakeLink;
  watch: ModuleSetWatch;
  clock: ReturnType<typeof manualTimers>;
  said: (level: string) => Record<string, unknown>[];
} => {
  const link = aFakeLink();
  link.behaviour.script = answers;
  link.behaviour.send = (): number => 1;
  const { log, lines } = aRecordingLogger();
  const clock = manualTimers();
  const watch = watchModuleSet({ link, nodeId: 'node-a', set, mode, log, timers: clock.timers });
  const said = (level: string): Record<string, unknown>[] =>
    lines.filter((line) => line['level'] === level);
  return { link, watch, clock, said };
};

describe('nodes that run one set but not one WORKSPACE_MODULES', () => {
  test('a node that finds another mode says so once, and says when they agree again', async () => {
    let live: string[] = ['chat|open', 'chat|managed'];
    const view = aWatch(() => live);
    await settle();

    expect(view.said('warn')).toHaveLength(1);
    expect(view.said('warn')[0]).toMatchObject({
      msg: 'the nodes of this cluster do not agree on WORKSPACE_MODULES; a module withheld from a workspace is served on the nodes that read it as open',
      thisNode: 'open',
      otherNodes: ['managed'],
    });
    await view.clock.tick();
    expect(view.said('warn')).toHaveLength(1);

    live = ['chat|open'];
    await view.clock.tick();
    expect(view.said('info').map((line) => line['msg'])).toEqual([
      'the nodes of this cluster agree on WORKSPACE_MODULES again',
    ]);
  });

  test('a different set with the same mode is the module set’s warning alone', async () => {
    const view = aWatch(() => ['chat|open', 'none|open']);
    await settle();

    expect(view.said('warn').map((line) => line['msg'])).toEqual([
      'the nodes of this cluster do not run the same modules; serving on, as in a rolling deploy',
    ]);
  });
});

describe('a set as one word', () => {
  test('the same modules are the same word, whatever their order, and the core alone is none', () => {
    expect(moduleSetOf(['chat', 'boards'])).toBe(moduleSetOf(['boards', 'chat']));
    expect(moduleSetOf([])).toBe('none');
  });
});

describe('nodes that run different sets', () => {
  test('a node that finds another set says so once, naming both, and keeps asking', async () => {
    const view = aWatch(() => ['chat|open', 'none|open']);
    await settle();

    const warnings = view.said('warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ thisNode: 'chat', otherNodes: ['none'] });
    expect(view.link.scripts[0]?.keys).toEqual([names.moduleSet]);
    expect(view.link.scripts[0]?.args.slice(0, 2)).toEqual(['node-a', 'chat|open']);

    await view.clock.tick();
    await view.clock.tick();
    expect(view.said('warn')).toHaveLength(1);
    expect(view.link.scripts).toHaveLength(3);
  });

  test('when the nodes agree again it says so, and says the next mismatch again', async () => {
    let live: string[] = ['chat|open', 'none|open'];
    const view = aWatch(() => live);
    await settle();
    live = ['chat|open'];
    await view.clock.tick();
    live = ['chat|open', 'none|open'];
    await view.clock.tick();

    expect(view.said('info').map((line) => line['msg'])).toEqual([
      'the nodes of this cluster run the same modules again',
    ]);
    expect(view.said('warn')).toHaveLength(2);
  });

  test('a node of an older release, which announces its set alone, is the same set and no disagreement', async () => {
    const view = aWatch(() => ['chat|open', 'chat']);
    await settle();

    expect(view.said('warn')).toHaveLength(0);
  });

  test('nodes of one set say nothing', async () => {
    const view = aWatch(() => ['chat|open']);
    await settle();
    await view.clock.tick();

    expect(view.said('warn')).toHaveLength(0);
    expect(view.said('info')).toHaveLength(0);
  });

  test('a Redis that is away is not a mismatch, and the node asks again', async () => {
    const view = aWatch(() => {
      throw new Error('redis is not connected');
    });
    await settle();
    await view.clock.tick();

    expect(view.said('warn')).toHaveLength(0);
    expect(view.link.scripts).toHaveLength(2);
  });

  test('a node whose first announcement could not be made asks again soon, and settles to the renewal once it is in the record', async () => {
    let connected = false;
    const view = aWatch(() => {
      if (!connected) throw new Error('redis is not connected');
      return ['chat|open'];
    });
    await settle();
    // A process announces itself as it starts, before its Redis connection is up: the record must not wait a third of the
    // lapse to hear of it, or a node that is behind is not seen by a restriction for that long.
    expect(view.clock.delays).toEqual([ANNOUNCE_RETRY_MS]);

    connected = true;
    await view.clock.tick();
    await view.clock.tick();
    expect(view.clock.delays).toEqual([ANNOUNCE_RETRY_MS, NODE_TTL_MS / 3, NODE_TTL_MS / 3]);
  });

  test('a node that stops stops asking and takes its entry out', async () => {
    const view = aWatch(() => ['chat|open']);
    await settle();
    await view.watch.stop();

    expect(view.clock.pending()).toBe(0);
    expect(view.link.sent).toEqual([{ command: 'HDEL', args: [names.moduleSet, 'node-a'] }]);
  });

  test('a node that cannot take its entry out says so at debug and still stops', async () => {
    const view = aWatch(() => ['chat|open']);
    view.link.behaviour.send = (): number => {
      throw new Error('redis is gone');
    };
    await settle();
    await view.watch.stop();

    expect(view.clock.pending()).toBe(0);
    expect(
      view.said('debug').some((line) => String(line['msg']).includes('could not be taken out')),
    ).toBe(true);
  });
});
