/**
 * A change of the settings served without a restart (D-179 §4): the sign-in library's instance and the
 * relay are rebuilt from what was saved and swapped in, through the real application — a request in
 * flight finishes on the pair it started on and the next is served by the new one, sessions outlive the
 * swap, GitHub and mail come and go with the settings, a change that cannot be built or checked saves
 * nothing and leaves the old pair serving, two changes at once run one after the other, and a hundred
 * swaps leave nothing behind.
 *
 * On a clone: a change commits in a transaction of its own, which a rolled-back test transaction cannot
 * hold. GitHub is the strict stand-in on a loopback port (`GITHUB_URL`), reached by the platform's own
 * `fetch`; the relays are scripted ones on this machine.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  sql,
  withRollback,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { createApp } from './app';
import { systemClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../../platform/config';
import { credentialCipher } from '../../platform/crypto';
import { NO_LOG } from '../../platform/events';
import { createLogger } from '../../platform/logging';
import { outbox, type Mailer } from '../../platform/mail';
import { deriveAuthSecret } from '../../modules/auth/better-auth';
import { inProcessEventBus } from '../../realtime/bus';
import { testConfig, testDependencies } from '../../testing/doubles';
import { aSignedInUser } from '../../testing/signed-in';
import { aGitHubPerson, cookiesFrom } from '../../testing/github-sign-in';
import { aGitHubStub, GITHUB_STUB_CREDENTIALS } from '../../testing/github-stub';
import { aScriptedRelay, type ScriptedRelay } from '../../testing/smtp-relay';
import { readSettings, saveSettings, type SmtpSettings } from '../../modules/setup/settings';
import {
  applySettings,
  runtimeServicesFrom,
  runtimeServicesHolder,
  SettingsChangeFailed,
  type RuntimeHolder,
  type RuntimeServices,
  type SettingsChange,
} from '../../modules/setup/runtime';

const ORIGIN = 'https://purlay.test';
const cipher = credentialCipher(DEVELOPMENT_ENCRYPTION_KEY);
const silent = createLogger({ level: 'silent' });

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

/** Every test starts from a server with nothing connected. */
beforeEach(async () => {
  await saveSettings(cloned.db, cipher, systemClock, {
    github: null,
    smtp: null,
    signUp: 'invite-only',
  });
});

type Build = SettingsChange['build'];

/** What the composition root has: a holder, settled from the database, and the change's needs. */
interface Server {
  readonly holder: RuntimeHolder;
  readonly change: SettingsChange;
  readonly app: ReturnType<typeof createApp>;
}

const aServer = async (
  githubUrl = 'https://github.com',
  wrap: (built: RuntimeServices) => RuntimeServices = (built) => built,
): Promise<Server> => {
  const holder = runtimeServicesHolder(silent);
  const build: Build = (settings, needsReentry) =>
    wrap(
      runtimeServicesFrom(
        settings,
        {
          database: cloned.db,
          baseUrl: ORIGIN,
          secret: deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY),
          log: silent,
          githubUrls: { web: githubUrl, api: githubUrl },
          sessionTtlDays: 30,
          bus: inProcessEventBus(() => undefined, NO_LOG),
          clock: systemClock,
        },
        needsReentry,
        holder.sends,
      ),
    );
  holder.settle(build(await readSettings(cloned.db, cipher), []));
  const app = createApp(
    testDependencies({
      database: cloned.db,
      config: testConfig({ APP_URL: ORIGIN }),
      auth: holder.auth,
      services: holder,
    }),
  );
  return { holder, app, change: { holder, cipher, clock: systemClock, log: silent, build } };
};

const methods = async (server: Server): Promise<unknown> =>
  await (await server.app.handle(new Request(`${ORIGIN}/api/auth/methods`))).json();

/** Where the button sends the browser: GitHub's authorize address, or nowhere (`null`, a 404). */
const authorizeAt = async (server: Server): Promise<[number, URL | null]> => {
  const button = await server.app.handle(new Request(`${ORIGIN}/auth/github`));
  const location = button.headers.get('location');
  return [button.status, location === null ? null : new URL(location)];
};

/** Asks for a sign-in link, as the screen does, and waits for what the answer left to do. */
const askForLink = async (server: Server, email: string): Promise<number> => {
  const response = await server.app.handle(
    new Request(`${ORIGIN}/auth/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email, locale: 'en' }),
    }),
  );
  await server.app.settled();
  await server.holder.sends.flush();
  return response.status;
};

const relayOf = (relay: ScriptedRelay): SmtpSettings => ({
  smtpUrl: `smtp://127.0.0.1:${String(relay.port)}`,
  from: 'no-reply@purlay.test',
  allowPlaintext: false,
});

const recipients = (relay: ScriptedRelay): string[] => relay.received.flatMap(({ to }) => to);

const failureOf = async (attempt: Promise<unknown>): Promise<unknown> =>
  await attempt.then(
    () => undefined,
    (error: unknown) => error,
  );

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

describe('integration: a change of the settings, served without a restart', () => {
  test('a request in flight finishes on the instance it started on, and the next is served by the new one', async () => {
    // Which instance each session lookup reached, and the first one's lookup held until let go.
    const reached: string[] = [];
    const entered = deferred();
    const release = deferred();
    let held = false;
    const labelled =
      (label: string) =>
      (built: RuntimeServices): RuntimeServices => {
        const real = built.auth.api.getSession;
        const getSession = (async (...args: Parameters<typeof real>) => {
          reached.push(label);
          if (label === 'A' && !held) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return await real(...args);
        }) as typeof real;
        return { ...built, auth: { ...built.auth, api: { ...built.auth.api, getSession } } };
      };
    await saveSettings(cloned.db, cipher, systemClock, {
      github: { clientId: 'client-A', clientSecret: 'secret-A' },
    });
    const server = await aServer('https://github.com', labelled('A'));

    // A write with a session cookie: the edge looks the session up, then the handler does again.
    const inFlight = server.app.handle(
      new Request(`${ORIGIN}/api/workspaces`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          cookie: `${SESSION_COOKIE}=a-token.a-signature`,
        },
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      }),
    );
    await entered.promise;
    await server.holder.replace(
      labelled('B')(
        server.change.build(
          {
            ...(await readSettings(cloned.db, cipher)),
            github: { clientId: 'client-B', clientSecret: 'secret-B' },
          },
          [],
        ),
      ),
    );
    release.resolve();
    expect((await inFlight).status).toBe(401);
    // Both lookups of the request in flight on the instance it started on, none on the new one.
    expect(reached).toEqual(['A', 'A']);

    // The next request: the new instance, which sends the browser to GitHub with the new app.
    const [status, location] = await authorizeAt(server);
    expect([status, location?.searchParams.get('client_id')]).toEqual([302, 'client-B']);
  });

  test('a session made before the swap is still a session after it: the secret is not a setting', async () => {
    const person = aGitHubPerson();
    const github = aGitHubStub(person);
    const served = github.serve(0);
    try {
      await saveSettings(cloned.db, cipher, systemClock, {
        github: GITHUB_STUB_CREDENTIALS,
        signUp: 'open',
      });
      const server = await aServer(served.url);
      const button = await server.app.handle(new Request(`${ORIGIN}/auth/github`));
      const granted = await fetch(button.headers.get('location') ?? '', { redirect: 'manual' });
      const back = await server.app.handle(
        new Request(granted.headers.get('location') ?? '', {
          headers: { cookie: cookiesFrom(button) },
        }),
      );
      expect(back.headers.get('location')).toBe(ORIGIN);
      const session = cookiesFrom(back);
      const before = server.holder.current();

      await applySettings(cloned.db, { github: null, signUp: 'invite-only' }, server.change);
      expect(server.holder.current()).not.toBe(before);
      const me = await server.app.handle(
        new Request(`${ORIGIN}/api/me`, { headers: { cookie: session } }),
      );
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ user: { email: person.email } });
    } finally {
      served.stop();
    }
  });

  test('GitHub comes and goes with the settings: the button, the provider and what the screen offers', async () => {
    const person = aGitHubPerson();
    const github = aGitHubStub(person);
    const served = github.serve(0);
    try {
      const server = await aServer(served.url);
      expect(await methods(server)).toEqual({
        github: false,
        email: false,
        oidc: null,
        signUp: 'invite-only',
      });
      expect((await authorizeAt(server))[0]).toBe(404);

      await applySettings(
        cloned.db,
        { github: GITHUB_STUB_CREDENTIALS, signUp: 'open' },
        server.change,
      );
      expect(await methods(server)).toEqual({
        github: true,
        email: false,
        oidc: null,
        signUp: 'open',
      });
      // The real mounted handler, through GitHub at `GITHUB_URL`: a person signs in.
      const button = await server.app.handle(new Request(`${ORIGIN}/auth/github`));
      expect(button.status).toBe(302);
      const granted = await fetch(button.headers.get('location') ?? '', { redirect: 'manual' });
      const back = await server.app.handle(
        new Request(granted.headers.get('location') ?? '', {
          headers: { cookie: cookiesFrom(button) },
        }),
      );
      expect(back.headers.get('location')).toBe(ORIGIN);
      expect(github.refusals).toEqual([]);

      await applySettings(cloned.db, { github: null }, server.change);
      expect(await methods(server)).toEqual({
        github: false,
        email: false,
        oidc: null,
        signUp: 'open',
      });
      expect((await authorizeAt(server))[0]).toBe(404);
      expect(server.holder.current()?.auth.github).toBe(false);
    } finally {
      served.stop();
    }
  });

  test('mail comes and goes with the settings, each letter through the relay current when it was asked for', async () => {
    const first = await aScriptedRelay();
    const second = await aScriptedRelay();
    try {
      const server = await aServer();
      expect(await methods(server)).toEqual({
        github: false,
        email: false,
        oidc: null,
        signUp: 'invite-only',
      });
      expect(await askForLink(server, 'ada@example.test')).toBe(503);
      expect('signInMagicLink' in (server.holder.current()?.auth.api ?? {})).toBe(false);

      // Who may sign up is built into the instance: the same change opens it.
      await applySettings(cloned.db, { smtp: relayOf(first), signUp: 'open' }, server.change);
      expect(await methods(server)).toEqual({
        github: false,
        email: true,
        oidc: null,
        signUp: 'open',
      });
      expect('signInMagicLink' in (server.holder.current()?.auth.api ?? {})).toBe(true);
      expect(await askForLink(server, 'ada@example.test')).toBe(202);
      expect(recipients(first)).toEqual(['ada@example.test']);

      // A letter the first relay is still to send when the second replaces it: sent by the first.
      server.holder
        .current()
        ?.mail?.post(
          { to: 'grace@example.test', subject: 's', text: 't', html: '<p>t</p>' },
          'test',
        );
      await applySettings(cloned.db, { smtp: relayOf(second) }, server.change);
      expect(recipients(first)).toEqual(['ada@example.test', 'grace@example.test']);
      expect(first.openSockets()).toBe(0);

      expect(await askForLink(server, 'linus@example.test')).toBe(202);
      expect(recipients(second)).toEqual(['linus@example.test']);
      expect(recipients(first)).toHaveLength(2);

      await applySettings(cloned.db, { smtp: null }, server.change);
      expect(await methods(server)).toEqual({
        github: false,
        email: false,
        oidc: null,
        signUp: 'open',
      });
      expect('signInMagicLink' in (server.holder.current()?.auth.api ?? {})).toBe(false);
      expect(await askForLink(server, 'ada@example.test')).toBe(503);
      expect([recipients(first).length, recipients(second).length]).toEqual([2, 1]);
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  test('a change that cannot be built, checked or saved saves nothing, and the old pair serves on', async () => {
    let builds = 0;
    let failBuild = false;
    let failCheck = false;
    const closed: string[] = [];
    const server = await aServer('https://github.com', (built) => {
      builds += 1;
      if (failBuild) throw new Error('the relay could not be built');
      if (!failCheck) return built;
      const mailer: Mailer = {
        send: async () => {
          await Promise.resolve();
        },
        verify: async () => {
          await Promise.resolve();
        },
        close: () => {
          closed.push('candidate');
        },
      };
      return {
        ...built,
        mailer,
        mail: outbox(mailer.send, silent),
        auth: {
          ...built.auth,
          schemaProblem: async (): Promise<string> =>
            await Promise.resolve('the tables are not what it expects'),
        },
      };
    });
    const serving = server.holder.current();
    const saved = await readSettings(cloned.db, cipher);
    const patch = { github: GITHUB_STUB_CREDENTIALS, signUp: 'open' } as const;

    failBuild = true;
    const unbuilt = await failureOf(applySettings(cloned.db, patch, server.change));
    failBuild = false;
    failCheck = true;
    const unchecked = await failureOf(applySettings(cloned.db, patch, server.change));
    failCheck = false;
    const unsaved = await failureOf(
      applySettings(cloned.db, { github: { clientId: '', clientSecret: 'x' } }, server.change),
    );

    expect(
      [unbuilt, unchecked, unsaved].map((failure) =>
        failure instanceof SettingsChangeFailed
          ? [failure.stage, failure.inEffect, failure.restartNeeded]
          : failure,
      ),
    ).toEqual([
      ['build', 'old', false],
      ['verify', 'old', false],
      ['save', 'old', false],
    ]);
    expect(builds).toBe(3);
    // The candidate the check refused is let go, never served.
    expect(closed).toEqual(['candidate']);
    expect(server.holder.current()).toBe(serving);
    expect(await readSettings(cloned.db, cipher)).toEqual(saved);
    expect(await methods(server)).toEqual({
      github: false,
      email: false,
      oidc: null,
      signUp: 'invite-only',
    });
  });

  test('a commit the database does not confirm swaps nothing, and says to restart', async () => {
    // Refused at COMMIT and not before: a deferred check, on this clone only, for the row this change writes.
    await sql`
      CREATE FUNCTION refuse_open_sign_up() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.sign_up = 'open' THEN RAISE EXCEPTION 'refused at commit'; END IF;
        RETURN NEW;
      END $$
    `.execute(cloned.db);
    await sql`
      CREATE CONSTRAINT TRIGGER refuse_open_sign_up AFTER INSERT OR UPDATE ON server_settings
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_open_sign_up()
    `.execute(cloned.db);
    try {
      const server = await aServer();
      const serving = server.holder.current();
      const failure = await failureOf(applySettings(cloned.db, { signUp: 'open' }, server.change));
      expect(
        failure instanceof SettingsChangeFailed
          ? [
              failure.stage,
              failure.inEffect,
              failure.restartNeeded,
              /restart/i.test(failure.message),
            ]
          : failure,
      ).toEqual(['commit', 'unknown', true, true]);
      expect(server.holder.current()).toBe(serving);
      // What the next start serves: the database, which kept nothing of the unconfirmed change.
      expect((await readSettings(cloned.db, cipher)).signUp).toBe('invite-only');
    } finally {
      await sql`DROP TRIGGER refuse_open_sign_up ON server_settings`.execute(cloned.db);
      await sql`DROP FUNCTION refuse_open_sign_up()`.execute(cloned.db);
    }
  });

  test('is refused before the settings are read, and inside a caller’s transaction', async () => {
    const holder = runtimeServicesHolder(silent);
    const change: SettingsChange = {
      holder,
      cipher,
      clock: systemClock,
      log: silent,
      build: () => {
        throw new Error('nothing is built before the settings are read');
      },
    };
    const starting = await failureOf(applySettings(cloned.db, { signUp: 'open' }, change));
    expect(starting).toBeInstanceOf(SettingsChangeFailed);
    expect((starting as SettingsChangeFailed).stage).toBe('starting');
    expect((await readSettings(cloned.db, cipher)).signUp).toBe('invite-only');

    const server = await aServer();
    const joined = await failureOf(
      withRollback(async (transaction) => {
        await applySettings(transaction, { signUp: 'open' }, server.change);
      }),
    );
    expect(String(joined)).toContain('pass the pool, not a transaction');
  });

  test('two changes at once run one after the other, the second built from what the first saved', async () => {
    const events: string[] = [];
    const gate = deferred();
    const server = await aServer('https://github.com', (built) => {
      events.push(
        `built ${built.settings.github?.clientId ?? 'without GitHub'}, sign-up ${built.settings.signUp}`,
      );
      return built;
    });
    // The pair serving now has a letter on its way that the first change waits for as it lets it go.
    const initial = server.holder.current();
    if (initial === undefined) throw new Error('settled above');
    const relay: Mailer = {
      send: async () => {
        await gate.promise;
      },
      verify: async () => {
        await Promise.resolve();
      },
      close: () => {
        events.push('let go the relay replaced');
      },
    };
    const mail = outbox(relay.send, silent, server.holder.sends);
    await server.holder.replace({ ...initial, mailer: relay, mail });
    events.length = 0;
    mail.post({ to: 'ada@example.test', subject: 's', text: 't', html: '<p>t</p>' }, 'test');

    const firstChange = applySettings(
      cloned.db,
      { github: { clientId: 'client-first', clientSecret: 'secret' } },
      server.change,
    );
    const secondChange = applySettings(cloned.db, { signUp: 'open' }, server.change);
    await Bun.sleep(100);
    gate.resolve();
    await Promise.all([firstChange, secondChange]);

    expect(events).toEqual([
      'built client-first, sign-up invite-only',
      'let go the relay replaced',
      'built client-first, sign-up open',
    ]);
    const serving = server.holder.current();
    expect([serving?.settings.github?.clientId, serving?.settings.signUp]).toEqual([
      'client-first',
      'open',
    ]);
    const saved = await readSettings(cloned.db, cipher);
    expect([saved.github?.clientId, saved.signUp]).toEqual(['client-first', 'open']);
  });

  test('a hundred swaps leave no instance, relay connection or timer behind', async () => {
    const relay = await aScriptedRelay();
    // Every timer started while the swaps run, and whether it is still waiting.
    const pending = new Set<unknown>();
    const stacks = new Map<unknown, string>();
    let intervals = 0;
    const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = globalThis;
    const { setInterval: realSetInterval } = globalThis;
    const retired: WeakRef<object>[] = [];
    try {
      const server = await aServer();
      const heapBefore = process.memoryUsage().heapUsed;
      globalThis.setTimeout = ((handler: () => void, ms?: number) => {
        const timer = realSetTimeout(() => {
          pending.delete(timer);
          handler();
        }, ms);
        pending.add(timer);
        stacks.set(timer, new Error().stack ?? '');
        return timer;
      }) as typeof setTimeout;
      globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
        pending.delete(timer);
        realClearTimeout(timer);
      }) as typeof clearTimeout;
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
        intervals += 1;
        return realSetInterval(...args);
      }) as typeof setInterval;

      for (let swap = 0; swap < 100; swap += 1) {
        const before = server.holder.current();
        if (before !== undefined) retired.push(new WeakRef(before.auth));
        await applySettings(
          cloned.db,
          swap % 2 === 0
            ? { smtp: relayOf(relay), github: GITHUB_STUB_CREDENTIALS }
            : { smtp: null, github: null },
          server.change,
        );
        if (swap % 2 === 0) {
          server.holder
            .current()
            ?.mail?.post(
              { to: `n${String(swap)}@example.test`, subject: 's', text: 't', html: '<p>t</p>' },
              'test',
            );
        }
      }
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      globalThis.setInterval = realSetInterval;
      await server.holder.sends.flush();
      // The relay sees each connection end a moment after it accepted the letter on it.
      for (let tries = 0; relay.openSockets() > 0 && tries < 200; tries += 1) await Bun.sleep(10);

      Bun.gc(true);
      await Bun.sleep(50);
      Bun.gc(true);
      const alive = retired.filter((reference) => reference.deref() !== undefined).length;
      const heapAfter = process.memoryUsage().heapUsed;
      // Written for the record: what the run measured.
      console.info(
        JSON.stringify({
          swaps: 100,
          retiredInstancesAlive: alive,
          timersPending: pending.size,
          timersPendingButThePoolsIdle: [...pending].filter(
            (timer) => stacks.get(timer)?.includes('pg-pool') !== true,
          ).length,
          intervalsStarted: intervals,
          relaySocketsOpen: relay.openSockets(),
          lettersSent: relay.received.length,
          heapGrowthMiB: Math.round(((heapAfter - heapBefore) / 1024 / 1024) * 10) / 10,
        }),
      );
      // The pool's idle timers are one per idle connection, bounded by the pool, whatever the swaps.
      const poolIdle = [...pending].filter((timer) => stacks.get(timer)?.includes('pg-pool'));
      const ours = [...pending].filter((timer) => !poolIdle.includes(timer));
      expect(relay.received).toHaveLength(50);
      expect(relay.openSockets()).toBe(0);
      expect(intervals).toBe(0);
      expect(ours.map((timer) => stacks.get(timer))).toEqual([]);
      expect(poolIdle.length).toBeLessThanOrEqual(10);
      // Collected as garbage, all but what a run of the collector keeps by chance.
      expect(alive).toBeLessThanOrEqual(5);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      globalThis.setInterval = realSetInterval;
      await relay.stop();
    }
  });
});

describe('integration: a socket across a change of the settings', () => {
  test('its admission and its open are each served by the one instance they started on', async () => {
    // Every session lookup and every read of the library's context, by the instance it reached; a
    // lookup armed to be held waits there until the test lets it go.
    const events: string[] = [];
    interface Hold {
      readonly entered: Deferred;
      readonly release: Deferred;
    }
    let armed: Hold | undefined;
    const arm = (): Hold => {
      armed = { entered: deferred(), release: deferred() };
      return armed;
    };
    const observed =
      (label: string) =>
      (built: RuntimeServices): RuntimeServices => {
        const real = built.auth.api.getSession;
        const getSession = (async (...args: Parameters<typeof real>) => {
          events.push(`lookup ${label}`);
          const hold = armed;
          if (hold !== undefined) {
            armed = undefined;
            hold.entered.resolve();
            await hold.release.promise;
          }
          return await real(...args);
        }) as typeof real;
        const auth = { ...built.auth, api: { ...built.auth.api, getSession } };
        Object.defineProperty(auth, '$context', {
          get: () => {
            events.push(`context ${label}`);
            return built.auth.$context;
          },
        });
        return { ...built, auth };
      };
    // What the next build is called: A at the start, then each swap's own.
    let naming = 'A';
    const server = await aServer('https://github.com', (built) => observed(naming)(built));
    const swapTo = async (label: string): Promise<void> => {
      naming = label;
      await server.holder.replace(server.change.build(await readSettings(cloned.db, cipher), []));
    };
    const person = await aSignedInUser(cloned.db, systemClock, 'socket-swap');
    // A session last used two hours ago is touched by the lookup: a second use of the instance, after
    // the lookup's own await, which is what a swap in between could send to another instance.
    const stale = async (): Promise<void> => {
      await cloned.db
        .updateTable('sessions')
        .set({ last_used_at: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where('id', '=', person.sessionId)
        .execute();
    };
    const port = server.app.listen(0);
    const open = (): WebSocket =>
      new WebSocket(`ws://127.0.0.1:${String(port)}/ws`, {
        headers: { cookie: person.cookie, origin: ORIGIN },
      } as unknown as string[]);
    const opened = async (socket: WebSocket): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => {
          resolve();
        });
        socket.addEventListener('error', () => {
          reject(new Error('the socket did not open'));
        });
      });
    };
    const until = async (done: () => boolean): Promise<void> => {
      for (let tries = 0; !done(); tries += 1) {
        if (tries > 300) throw new Error(`waited in vain; saw ${JSON.stringify(events)}`);
        await Bun.sleep(10);
      }
    };
    const sockets: WebSocket[] = [];
    try {
      await stale();
      const admission = arm();
      const first = open();
      sockets.push(first);
      // The admission's lookup is held on A; the settings change underneath it.
      await admission.entered.promise;
      await swapTo('B');
      const opening = arm();
      const firstOpened = opened(first);
      admission.release.resolve();
      // The open is a flow of its own: it starts on B, and is held there while the settings change again.
      await opening.entered.promise;
      await stale();
      await swapTo('C');
      opening.release.resolve();
      await firstOpened;
      await until(() => events.includes('context B'));

      // A socket opened now is admitted, and opened, by C.
      const second = open();
      sockets.push(second);
      await opened(second);
      await until(() => events.filter((event) => event === 'lookup C').length >= 2);

      // The first socket: admitted wholly by A, opened wholly by B; the second, only ever by C.
      expect(events.slice(0, 4)).toEqual(['lookup A', 'context A', 'lookup B', 'context B']);
      expect(new Set(events.slice(4))).toEqual(new Set(['lookup C']));
    } finally {
      for (const socket of sockets) socket.close();
      await server.app.stop(true);
    }
  }, 20_000);
});
