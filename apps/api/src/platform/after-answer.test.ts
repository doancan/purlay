/**
 * Work left for after an answer (`after-answer.ts`): nobody is left to tell of a failure, so it is
 * written down — without what it might quote — and never thrown; and `settled` is what a shutdown
 * waits on, so it must wait for everything, even what starts while it waits.
 */
import { describe, expect, test } from 'bun:test';
import { aRecordingLogger } from '../testing/doubles';
import { afterAnswer } from './after-answer';

/** A promise the test resolves by hand. */
const aGate = (): { readonly opened: Promise<void>; readonly open: () => void } => {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

/** Lets every queued continuation run. */
const aTurn = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** A failure the way a driver hands one over: an address in the message and in its detail. */
const aDriverError = (): Error =>
  Object.assign(new Error('duplicate key value: (email)=(ada@example.test)'), {
    code: '23505',
    detail: 'Key (email)=(ada@example.test) already exists.',
  });

describe('work left for after an answer', () => {
  test('a piece that fails is written down by its purpose and code, never its words, and not thrown', async () => {
    const { log, lines } = aRecordingLogger();
    const after = afterAnswer(log, 'sign-in');
    after.run(() => Promise.reject(aDriverError()));
    await after.settled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ purpose: 'sign-in', reason: '23505' });
    expect(JSON.stringify(lines)).not.toContain('ada@example.test');
  });

  test('a piece that throws before it returns a promise is caught the same way', async () => {
    const { log, lines } = aRecordingLogger();
    const after = afterAnswer(log, 'sign-in');
    expect(() => {
      after.run(() => {
        throw aDriverError();
      });
    }).not.toThrow();
    await after.settled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ purpose: 'sign-in', reason: '23505' });
    expect(JSON.stringify(lines)).not.toContain('ada@example.test');
  });

  test('settled waits for every piece, a failed one included', async () => {
    const after = afterAnswer(aRecordingLogger().log, 'sign-in');
    const gate = aGate();
    after.run(async () => {
      await gate.opened;
      throw new Error('late');
    });
    let settled = false;
    const waiting = after.settled().then(() => {
      settled = true;
    });
    await aTurn();
    expect(settled).toBe(false);
    gate.open();
    await waiting;
    expect(settled).toBe(true);
  });

  test('settled waits for a piece started while it was waiting', async () => {
    const after = afterAnswer(aRecordingLogger().log, 'sign-in');
    const [first, second] = [aGate(), aGate()];
    after.run(async () => {
      await first.opened;
    });
    let settled = false;
    const waiting = after.settled().then(() => {
      settled = true;
    });
    // Another request answered while the shutdown waits leaves its own piece.
    after.run(async () => {
      await second.opened;
    });
    first.open();
    await aTurn();
    expect(settled).toBe(false);
    second.open();
    await waiting;
    expect(settled).toBe(true);
  });

  test('settled with nothing started resolves at once', async () => {
    await afterAnswer(aRecordingLogger().log, 'sign-in').settled();
  });
});
