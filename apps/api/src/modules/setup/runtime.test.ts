/**
 * The holder of what the server serves with (D-179 §4): a swap puts the new pair in place at once, lets
 * the replaced relay finish what it was sending before its transport is closed, keeps every letter of
 * every relay in one ledger for the shutdown, pins a flow to the pair it started on, and runs changes
 * one at a time. With doubles: no database, no relay — the integration test has those
 * (`ingress/http/settings-swap.integration.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { anAuthThatMustNotBeTouched } from '../../testing/doubles';
import { createLogger } from '../../platform/logging';
import { outbox, type MailMessage, type Mailer } from '../../platform/mail';
import { runtimeServicesHolder, SettingsChangeFailed, type RuntimeServices } from './runtime';
import type { ServerSettings } from './settings';

const silent = createLogger({ level: 'silent' });

const NOTHING_SET: ServerSettings = {
  signUp: 'invite-only',
  github: undefined,
  oidc: undefined,
  smtp: undefined,
  workspaceCreators: { kind: 'first' },
  setupCompletedAt: undefined,
};

const LETTER: MailMessage = { to: 'ada@example.test', subject: 's', text: 't', html: '<p>t</p>' };

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

const deferred = (): Deferred => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** A relay whose every send waits for `gate`, saying what happened to it in `events`. */
const aRelayDouble = (
  name: string,
  events: string[],
  gate: Promise<void> = Promise.resolve(),
): Mailer => ({
  send: async (message): Promise<void> => {
    await gate;
    events.push(`${name} sent to ${message.to}`);
  },
  verify: async (): Promise<void> => {
    await Promise.resolve();
  },
  close: (): void => {
    events.push(`${name} closed`);
  },
});

const servicesWith = (
  holder: ReturnType<typeof runtimeServicesHolder>,
  mailer: Mailer | undefined,
  auth = anAuthThatMustNotBeTouched(),
): RuntimeServices => ({
  auth,
  mailer,
  mail: mailer === undefined ? undefined : outbox(mailer.send, silent, holder.sends),
  needsReentry: [],
  settings: NOTHING_SET,
});

describe('a swap of the services', () => {
  test('serves the new pair at once, and closes the old relay only after what it was sending is out', async () => {
    const holder = runtimeServicesHolder(silent);
    const events: string[] = [];
    const gate = deferred();
    const old = servicesWith(holder, aRelayDouble('old', events, gate.promise));
    holder.settle(old);
    old.mail?.post(LETTER, 'test');
    const next = servicesWith(holder, aRelayDouble('new', events));

    const swapped = holder.replace(next);
    // In place before the old relay is done: the next request is served by the new pair.
    expect(holder.current()).toBe(next);
    await Bun.sleep(20);
    expect(events).toEqual([]);

    gate.resolve();
    await swapped;
    expect(events).toEqual(['old sent to ada@example.test', 'old closed']);
  });

  test('a letter the replaced relay is handed after it was let go is still waited for by the shutdown', async () => {
    const holder = runtimeServicesHolder(silent);
    const events: string[] = [];
    const gate = deferred();
    const old = servicesWith(holder, aRelayDouble('old', events, gate.promise));
    holder.settle(old);
    await holder.replace(servicesWith(holder, undefined));
    expect(events).toEqual(['old closed']);

    // Work a request left for after its answer, on the pair it started on: the old outbox.
    old.mail?.post(LETTER, 'test');
    let flushed = false;
    const shutdown = holder.sends.flush(5_000).then(() => {
      flushed = true;
    });
    await Bun.sleep(20);
    expect(flushed).toBe(false);
    gate.resolve();
    await shutdown;
    expect(events).toEqual(['old closed', 'old sent to ada@example.test']);
  });

  test('is refused before the first pair is settled: there is nothing to replace', async () => {
    const holder = runtimeServicesHolder(silent);
    let refused: unknown;
    try {
      await holder.replace(servicesWith(holder, undefined));
    } catch (error) {
      refused = error;
    }
    expect(String(refused)).toContain('settle first');
    // Refused before anything was put in place: still nothing serves.
    expect(holder.current()).toBeUndefined();
  });

  test('a flow pinned to a pair keeps it across a swap; one started after is served by the new one', async () => {
    const holder = runtimeServicesHolder(silent);
    const reachedOld = new Error('old');
    const reachedNew = new Error('new');
    holder.settle(servicesWith(holder, undefined, anAuthThatMustNotBeTouched(reachedOld)));
    const reached = (): unknown => {
      try {
        return holder.auth.handler;
      } catch (error) {
        return error;
      }
    };
    const gate = deferred();
    const inFlight = holder.within(async () => {
      const first = reached();
      await gate.promise;
      return [first, reached()];
    });
    await holder.replace(servicesWith(holder, undefined, anAuthThatMustNotBeTouched(reachedNew)));
    const after = holder.within(() => reached());
    gate.resolve();
    expect(await inFlight).toEqual([reachedOld, reachedOld]);
    expect(after).toBe(reachedNew);
  });

  test('changes run one at a time, in the order they were asked, a failure holding up nobody', async () => {
    const holder = runtimeServicesHolder(silent);
    const events: string[] = [];
    const gate = deferred();
    const first = holder.exclusively(async () => {
      events.push('first starts');
      await gate.promise;
      events.push('first ends');
      throw new SettingsChangeFailed('build');
    });
    const second = holder.exclusively(async () => {
      events.push('second starts');
      await Promise.resolve();
      return 'second';
    });
    await Bun.sleep(10);
    gate.resolve();
    expect(await first.catch((error: unknown) => error)).toBeInstanceOf(SettingsChangeFailed);
    expect(await second).toBe('second');
    expect(events).toEqual(['first starts', 'first ends', 'second starts']);
  });
});

describe('a change that did not complete', () => {
  test('says what serves now, and asks for a restart only where the database and the process may disagree', () => {
    const said = (
      ['starting', 'shutting-down', 'save', 'build', 'verify', 'commit', 'retire'] as const
    ).map((stage) => {
      const failed = new SettingsChangeFailed(stage);
      return [stage, failed.inEffect, failed.restartNeeded, /restart/i.test(failed.message)];
    });
    expect(said).toEqual([
      ['starting', 'old', false, false],
      ['shutting-down', 'old', false, false],
      ['save', 'old', false, false],
      ['build', 'old', false, false],
      ['verify', 'old', false, false],
      ['commit', 'unknown', true, true],
      ['retire', 'new', true, true],
    ]);
  });
});
