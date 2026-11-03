/**
 * The check that nodes of a cluster run one module set (D-250): a mismatch is said once and never stops a
 * node, it is said again as over when the nodes agree, and a Redis that is away is not a mismatch. The script
 * that keeps the shared record is held against a real Redis (`module-set.redis.integration.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { aRecordingLogger } from '../testing/doubles';
import { aFakeLink, type FakeLink } from '../testing/redis';
import type { Timers } from './hub';
import { moduleSetOf, MODULE_SET_KEY, watchModuleSet, type ModuleSetWatch } from './module-set';

/** Timers that run when the test says: the renewal is a turn of the loop, not a wait. */
const manualTimers = (): { timers: Timers; tick: () => Promise<void>; pending: () => number } => {
  const waiting = new Map<number, () => void>();
  let id = 0;
  return {
    timers: {
      set: (callback): number => {
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
  const watch = watchModuleSet({ link, nodeId: 'node-a', set, log, timers: clock.timers });
  const said = (level: string): Record<string, unknown>[] =>
    lines.filter((line) => line['level'] === level);
  return { link, watch, clock, said };
};

describe('a set as one word', () => {
  test('the same modules are the same word, whatever their order, and the core alone is none', () => {
    expect(moduleSetOf(['chat', 'boards'])).toBe(moduleSetOf(['boards', 'chat']));
    expect(moduleSetOf([])).toBe('none');
  });
});

describe('nodes that run different sets', () => {
  test('a node that finds another set says so once, naming both, and keeps asking', async () => {
    const view = aWatch(() => ['chat', 'none']);
    await settle();

    const warnings = view.said('warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ thisNode: 'chat', otherNodes: ['none'] });
    expect(view.link.scripts[0]?.keys).toEqual([MODULE_SET_KEY]);
    expect(view.link.scripts[0]?.args.slice(0, 2)).toEqual(['node-a', 'chat']);

    await view.clock.tick();
    await view.clock.tick();
    expect(view.said('warn')).toHaveLength(1);
    expect(view.link.scripts).toHaveLength(3);
  });

  test('when the nodes agree again it says so, and says the next mismatch again', async () => {
    let live: string[] = ['chat', 'none'];
    const view = aWatch(() => live);
    await settle();
    live = ['chat'];
    await view.clock.tick();
    live = ['chat', 'none'];
    await view.clock.tick();

    expect(view.said('info').map((line) => line['msg'])).toEqual([
      'the nodes of this cluster run the same modules again',
    ]);
    expect(view.said('warn')).toHaveLength(2);
  });

  test('nodes of one set say nothing', async () => {
    const view = aWatch(() => ['chat']);
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

  test('a node that stops stops asking and takes its entry out', async () => {
    const view = aWatch(() => ['chat']);
    await settle();
    await view.watch.stop();

    expect(view.clock.pending()).toBe(0);
    expect(view.link.sent).toEqual([{ command: 'HDEL', args: [MODULE_SET_KEY, 'node-a'] }]);
  });

  test('a node that cannot take its entry out says so at debug and still stops', async () => {
    const view = aWatch(() => ['chat']);
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
