/**
 * The shutdown's order and its two ways out, without a process (#220).
 */
import { describe, expect, test } from 'bun:test';
import { createLogger } from './platform/logging';
import {
  closeAfterDrain,
  drainRefusingChanges,
  installCrashHandlers,
  installShutdown,
  type ProcessLike,
} from './lifecycle';
import type { Timers } from './realtime/hub';
import { outbox, smtpMailer } from './platform/mail';
import { credentialCipher } from './platform/crypto';
import { DEVELOPMENT_ENCRYPTION_KEY } from './platform/config';
import { systemClock } from './platform/clock';
import { aDatabaseThatMustNotBeTouched, anAuthThatMustNotBeTouched } from './testing/doubles';
import { aScriptedRelay } from './testing/smtp-relay';
import {
  applySettings,
  runtimeServicesHolder,
  SettingsChangeFailed,
  type RuntimeHolder,
  type RuntimeServices,
} from './modules/setup/runtime';
import type { ServerSettings } from './modules/setup/settings';

const harness = (
  drain: () => Promise<void>,
): {
  steps: string[];
  fireDeadline: () => void;
  signal: (name: 'SIGTERM' | 'SIGINT') => void;
  start: (signal: string) => Promise<void>;
} => {
  const steps: string[] = [];
  const handlers = new Map<string, () => void>();
  let deadline: (() => void) | undefined;
  const process: ProcessLike = {
    on: (signal, handler) => {
      handlers.set(signal, handler);
    },
    exit: (code) => {
      steps.push(`exit ${String(code)}`);
    },
  };
  const timers: Timers = {
    set: (callback) => {
      deadline = callback;
      return 1;
    },
    clear: () => {
      steps.push('deadline cleared');
      deadline = undefined;
    },
  };
  const start = installShutdown({
    drain: async () => {
      steps.push('drain');
      await drain();
    },
    closeDatabase: async () => {
      steps.push('database closed');
      await Promise.resolve();
    },
    log: createLogger({ level: 'silent' }),
    process,
    deadlineMs: 10_000,
    timers,
  });
  return {
    steps,
    start,
    fireDeadline: () => deadline?.(),
    signal: (name) => handlers.get(name)?.(),
  };
};

describe('shutting down', () => {
  test('drains, then closes the pool, then exits 0 — and the deadline is cleared', async () => {
    const run = harness(async () => {
      await Promise.resolve();
    });
    await run.start('SIGTERM');
    expect(run.steps).toEqual(['drain', 'database closed', 'deadline cleared', 'exit 0']);
  });

  test('both signals are wired, and a second does not start a second shutdown', async () => {
    const run = harness(async () => {
      await Bun.sleep(5);
    });
    run.signal('SIGTERM');
    run.signal('SIGINT');
    await Bun.sleep(20);
    expect(run.steps.filter((step) => step === 'drain')).toHaveLength(1);
    expect(run.steps.at(-1)).toBe('exit 0');
  });

  test('a drain that never finishes is cut off at the deadline, with exit 1', () => {
    const run = harness(async () => {
      await new Promise<void>(() => undefined);
    });
    void run.start('SIGTERM');
    run.fireDeadline();
    expect(run.steps).toEqual(['drain', 'exit 1']);
  });

  test('a drain that fails exits 1 rather than hanging', async () => {
    const run = harness(async () => {
      await Promise.reject(new Error('the listener would not stop'));
    });
    await run.start('SIGTERM');
    expect(run.steps).toEqual(['drain', 'deadline cleared', 'exit 1']);
  });
});

describe('an error that escaped every handler (#634)', () => {
  const crashHarness = (
    flush: () => Promise<void> = async () => {
      await Promise.resolve();
    },
    throwing = false,
  ): {
    steps: string[];
    errors: { message: string; fields: Record<string, unknown> | undefined }[];
    reports: { message: string; fields: Record<string, unknown> }[];
    fire: (event: 'unhandledRejection' | 'uncaughtException', reason: unknown) => void;
    fireDeadline: () => void;
    crash: ReturnType<typeof installCrashHandlers>;
  } => {
    const steps: string[] = [];
    const errors: { message: string; fields: Record<string, unknown> | undefined }[] = [];
    const reports: { message: string; fields: Record<string, unknown> }[] = [];
    const handlers = new Map<string, (reason: unknown) => void>();
    let deadline: (() => void) | undefined;
    const silent = createLogger({ level: 'silent' });
    const crash = installCrashHandlers({
      log: {
        ...silent,
        error: (message, fields) => {
          // Only when walking the reason, as the real logger does with a getter that throws.
          if (throwing && fields !== undefined && 'err' in fields) {
            throw new TypeError('a getter on the reason threw');
          }
          errors.push({ message, fields });
        },
      },
      report: (message, fields) => {
        reports.push({ message, fields });
      },
      flush: async () => {
        steps.push('flush');
        await flush();
      },
      process: {
        on: (event, handler) => {
          handlers.set(event, handler);
        },
        exit: (code) => {
          steps.push(`exit ${String(code)}`);
        },
      },
      deadlineMs: 2_000,
      timers: {
        set: (callback) => {
          deadline = callback;
          return 1;
        },
        clear: () => {
          deadline = undefined;
        },
      },
    });
    crash.onCrash(() => {
      steps.push('stop taking work');
    });
    return {
      steps,
      errors,
      reports,
      crash,
      fire: (event, reason) => handlers.get(event)?.(reason),
      fireDeadline: () => deadline?.(),
    };
  };

  test('a rejection nobody handled is logged as an error — so the tracker hears it — then the process exits 1', async () => {
    const run = crashHarness();
    const reason = new Error('a timer callback threw');
    run.fire('unhandledRejection', reason);
    await Bun.sleep(0);
    expect(run.errors).toEqual([
      {
        message: 'an error escaped every handler; exiting',
        fields: { err: reason, kind: 'unhandledRejection' },
      },
    ]);
    // Reported as urgent, past a tracker full of ordinary reports; then no more work, then out.
    expect(run.reports).toEqual([
      {
        message: 'an error escaped every handler; exiting',
        fields: { err: reason, kind: 'unhandledRejection' },
      },
    ]);
    expect(run.steps).toEqual(['stop taking work', 'flush', 'exit 1']);
    expect(run.crash.crashed()).toBe(true);
  });

  test('an uncaught exception is the same, named as such', async () => {
    const run = crashHarness();
    run.fire('uncaughtException', new Error('boom'));
    await Bun.sleep(0);
    expect(run.errors[0]?.fields?.['kind']).toBe('uncaughtException');
    expect(run.steps).toEqual(['stop taking work', 'flush', 'exit 1']);
  });

  test('a tracker that will not flush does not keep a broken process alive', () => {
    const run = crashHarness(async () => {
      await new Promise<void>(() => undefined);
    });
    run.fire('uncaughtException', new Error('boom'));
    run.fireDeadline();
    expect(run.steps).toEqual(['stop taking work', 'flush', 'exit 1']);
  });

  test('a flush that fails still exits 1', async () => {
    const run = crashHarness(async () => {
      await Promise.reject(new Error('the collector is down'));
    });
    run.fire('unhandledRejection', 'not even an Error');
    await Bun.sleep(0);
    expect(run.steps).toEqual(['stop taking work', 'flush', 'exit 1']);
  });

  test('in a real process, both kinds are heard and end it with 1, the error logged', async () => {
    // What the runtime actually emits, not what its documentation says it emits (CONTRIBUTING §6.3).
    const lifecycle = new URL('./lifecycle.ts', import.meta.url).pathname;
    const logging = new URL('./platform/logging.ts', import.meta.url).pathname;
    for (const fault of [
      'void Promise.reject(new Error("nobody awaited this"));',
      'setTimeout(() => { throw new Error("thrown from a timer"); }, 0);',
    ]) {
      const child = Bun.spawn(
        [
          process.execPath,
          '-e',
          `import { installCrashHandlers } from ${JSON.stringify(lifecycle)};
           import { createLogger } from ${JSON.stringify(logging)};
           installCrashHandlers({ log: createLogger({ level: 'error' }), report: () => undefined, flush: () => Promise.resolve(), process, deadlineMs: 2000 });
           ${fault}
           setTimeout(() => { console.log('still alive'); process.exit(0); }, 1000);`,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const code = await child.exited;
      const out = await new Response(child.stdout).text();
      expect(code, fault).toBe(1);
      expect(out).toContain('an error escaped every handler; exiting');
      expect(out).not.toContain('still alive');
    }
  });

  test('a reason the logger cannot describe still ends the process, said without it', async () => {
    // A reason with a getter that throws, or a Proxy: the logger walks it and throws (#634 review).
    const run = crashHarness(undefined, true);
    run.fire('uncaughtException', new Error('boom'));
    await Bun.sleep(0);
    expect(run.steps).toEqual(['stop taking work', 'flush', 'exit 1']);
    expect(run.reports.map((r) => r.fields['kind'])).toEqual(['uncaughtException']);
  });

  test('a shutdown that was draining when it crashed exits 1, not 0', async () => {
    const run = crashHarness(async () => {
      await Bun.sleep(5);
    });
    const exits: number[] = [];
    const start = installShutdown({
      drain: async () => {
        run.fire('unhandledRejection', new Error('while draining'));
        await Promise.resolve();
      },
      closeDatabase: async () => {
        await Promise.resolve();
      },
      log: createLogger({ level: 'silent' }),
      process: {
        on: () => undefined,
        exit: (code) => {
          exits.push(code);
        },
      },
      deadlineMs: 10_000,
      timers: { set: () => 1, clear: () => undefined },
      crashed: run.crash.crashed,
    });
    await start('SIGTERM');
    expect(exits).toEqual([1]);
  });

  test('a second error while exiting is logged, and exits once', async () => {
    const run = crashHarness(async () => {
      await Bun.sleep(5);
    });
    run.fire('uncaughtException', new Error('first'));
    run.fire('unhandledRejection', new Error('second'));
    await Bun.sleep(20);
    expect(run.errors).toHaveLength(2);
    expect(run.steps.filter((step) => step === 'exit 1')).toHaveLength(1);
  });
});

describe('shutting down a server whose relay the settings replaced (D-179 §4.9)', () => {
  const silent = createLogger({ level: 'silent' });
  const NOTHING_SET: ServerSettings = {
    signUp: 'invite-only',
    github: undefined,
    oidc: undefined,
    smtp: undefined,
    workspaceCreators: { kind: 'first' },
    setupCompletedAt: undefined,
    requireTwoFactor: false,
    passwordSignIn: true,
  };
  const pairOf = (holder: RuntimeHolder, port: number | undefined): RuntimeServices => {
    const mailer =
      port === undefined
        ? undefined
        : smtpMailer({
            SMTP_URL: `smtp://127.0.0.1:${String(port)}`,
            MAIL_FROM: 'no-reply@purlay.test',
            SMTP_ALLOW_PLAINTEXT: false,
          });
    return {
      auth: anAuthThatMustNotBeTouched(),
      mailer,
      mail: mailer === undefined ? undefined : outbox(mailer.send, silent, holder.sends),
      needsReentry: [],
      settings: NOTHING_SET,
    };
  };

  test('a letter the replaced relay still holds is sent before the pool closes, and no change starts once draining', async () => {
    const relay = await aScriptedRelay();
    try {
      const holder = runtimeServicesHolder(silent);
      const replaced = pairOf(holder, relay.port);
      holder.settle(replaced);
      await holder.replace(pairOf(holder, undefined));
      // Work a request left for after its answer, on the pair it started on: the relay now replaced.
      replaced.mail?.post(
        { to: 'ada@example.test', subject: 's', text: 't', html: '<p>t</p>' },
        'sign-in',
      );

      const steps: string[] = [];
      const refusals: unknown[] = [];
      const shutdown = installShutdown({
        drain: drainRefusingChanges(holder, async () => {
          refusals.push(
            await applySettings(
              aDatabaseThatMustNotBeTouched(),
              { signUp: 'open' },
              {
                holder,
                cipher: credentialCipher(DEVELOPMENT_ENCRYPTION_KEY),
                clock: systemClock,
                log: silent,
                build: () => {
                  throw new Error('nothing is built while the server drains');
                },
              },
            ).then(
              () => 'applied',
              (error: unknown) => error,
            ),
          );
          steps.push('drained');
        }),
        closeDatabase: closeAfterDrain({
          services: holder,
          errorTracker: { flush: async () => await Promise.resolve(true) },
          database: {
            destroy: async (): Promise<void> => {
              steps.push(`pool closed, ${String(relay.received.length)} letter(s) at the relay`);
              await Promise.resolve();
            },
          },
        }),
        log: silent,
        process: {
          on: () => undefined,
          exit: (code) => {
            steps.push(`exit ${String(code)}`);
          },
        },
        deadlineMs: 10_000,
      });
      await shutdown('SIGTERM');

      expect(steps).toEqual(['drained', 'pool closed, 1 letter(s) at the relay', 'exit 0']);
      expect(relay.received.flatMap(({ to }) => to)).toEqual(['ada@example.test']);
      expect(
        refusals.map((refusal) =>
          refusal instanceof SettingsChangeFailed ? [refusal.stage, refusal.inEffect] : refusal,
        ),
      ).toEqual([['shutting-down', 'old']]);
    } finally {
      await relay.stop();
    }
  });
});

describe('what a drained process closes last (D-201)', () => {
  test('the shared Redis connections close after the pool, and only when there are some', async () => {
    const steps: string[] = [];
    const held = {
      services: runtimeServicesHolder(createLogger({ level: 'silent' })),
      errorTracker: { flush: async (): Promise<boolean> => await Promise.resolve(true) },
      database: {
        destroy: async (): Promise<void> => {
          steps.push('pool');
          await Promise.resolve();
        },
      },
    };
    await closeAfterDrain({
      ...held,
      redis: {
        close: (): void => {
          steps.push('redis');
        },
      },
    })();
    await closeAfterDrain(held)();
    expect(steps).toEqual(['pool', 'redis', 'pool']);
  });

  test('and when the pool will not close, the connections are closed all the same', async () => {
    let closed = false;
    const held = {
      services: runtimeServicesHolder(createLogger({ level: 'silent' })),
      errorTracker: { flush: async (): Promise<boolean> => await Promise.resolve(true) },
      database: {
        destroy: async (): Promise<void> => {
          await Promise.resolve();
          throw new Error('the pool would not close');
        },
      },
      redis: {
        close: (): void => {
          closed = true;
        },
      },
    };
    await closeAfterDrain(held)().catch(() => undefined);
    expect(closed).toBe(true);
  });
});
