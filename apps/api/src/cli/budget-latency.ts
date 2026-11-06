/**
 * The two latency budgets nothing measured (`PRD.md` §5, D-49, #73): the server's ACK round-trip and
 * the fan-out to another connected client, each as a p95.
 *
 *   bun run budget:latency                          measure and report
 *   bun run budget:latency -- --record <file>       … and keep the result for the next run
 *   bun run budget:latency -- --baseline <file>     … and fail if either p95 jumped past the last one
 *   bun run budget:latency -- --keep <file>         both, against the file if there is one, and keep
 *                                                   the run only if it passed (what CI does)
 *
 * A real API process, started as the image starts it, against a clone of the integration database
 * that is dropped afterwards; two people signed in on two real sockets in one channel; one sends at a
 * pace inside the rate budgets, and every message is timed from the frame leaving to its `ACK` on the
 * sender's socket and to its `MESSAGE_CREATED` on the other's.
 *
 * Three independent API processes are measured sequentially, sixty messages each. The lowest of
 * their p95s is compared, with every trial reported and recorded (D-267): a stall only ever adds to
 * a trial, so the lowest is the run's own floor, and a real slowdown raises every trial and with it
 * the floor. Never retry until a pass (D-49).
 *
 * **With issues busy** (`MODULES.md` §7): after those, the same trials run again while people read issues' list as
 * fast as the API answers, in the same process and on the same pool. Chat is not budgeted and issues is, so chat's
 * p95 must stay within the budget's own rule — past `REGRESSION_FACTOR` times the quiet trials of the same run and
 * past the noise floor is a regression — with the same second look. The comparison is with this run's quiet
 * numbers, the baseline mechanism above, because what is asked is what issues adds, not what this machine does today.
 *
 * **Every module's hot path, with the others busy** (D-250 rule 6): `HOT_PATHS` says, for each bundled module, how its hot
 * path is timed and how it is made busy, or why it has none. Chat's is the send above. Issues' is the list of a
 * workspace's issues through its route, timed while chat's senders hold chat's share of the pool, and is judged as the
 * quiet trials are: the lowest of three trials against the number recorded for it in the baseline file, by `limitOf`.
 *
 * **A regression must happen twice** (D-227): a run that regressed is measured again, three more trials,
 * once, and fails only if that regresses too. `--record` keeps the run judged last; both are printed.
 *
 * **It blocks on a regression, never on the line** (D-49): a p95 on a shared machine moves by tens of
 * percent between identical runs, and a gate people learn to re-run has stopped being a gate. So with a
 * baseline it fails when a p95 is more than `REGRESSION_FACTOR` times the recorded one, more than
 * `FLOOR_SPREAD_MS` above it *and* past the budget's floor of interest; without one it reports, with the
 * budget beside each number.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { cloneIntegrationDatabase, sql, type ClonedDatabase } from '@purlay/db';
import { MODULE_IDS, messageId, type ModuleId } from '@purlay/types';
import { systemClock } from '../platform/clock';
import { SESSION_COOKIE } from '../platform/cookies';
import { issueSession } from '../modules/auth/sessions';
import { deriveAuthSecret } from '../modules/auth/better-auth';

export const BUDGETS = { ackMs: 120, fanOutMs: 200 } as const;
/** A jump: this many times the recorded p95. */
export const REGRESSION_FACTOR = 1.5;
/** Below this a jump is noise: a p95 of 4 ms becoming 7 ms is not a regression anyone feels. */
const NOISE_FLOOR_MS = 20;
/**
 * How far one runner's lowest trial lies from another's with identical code (D-267). Measured: the lowest ACK p95
 * of three trials in 80 `schema` jobs on identical code ran from 9.8 to 17.0 ms, a spread of 7.2 ms, while a single
 * trial ran from 10 to 70 ms; so a stall is not what a jump of the lowest trial has to be told from, a different
 * machine is. A jump must clear that spread with room, or one runner being quicker than the last one is a regression.
 */
export const FLOOR_SPREAD_MS = 10;

/**
 * Starvation, not slowness: with issues busy chat's p95 may be this many times the quiet p95 of the same run before
 * the gate says the pool was taken. Evidence, in the order it was measured: on a two-core CI runner, with the budget
 * in place, a busy issues module cost chat 2.4 to 3.7 times (database backends and the shared host's CPU, not the
 * pool); on a laptop with the budget removed, the same scenario cost 727 to 774 ms against 36 ms quiet, about 20
 * to 23 times. Eight is past the first and well under the second. What a CI runner does without the budget is not
 * measured here; it is expected to be at least as bad as the laptop, since the readers then hold the whole pool.
 * The noise floor of `jumped` still applies, so a quiet p95 of a few milliseconds does not make the ratio meaningless.
 */
export const STARVATION_FACTOR = 8;

/** What a number may be, given the one recorded before it: the most of the factor, the spread of the floor and the noise floor. */
export const limitOf = (before: number, factor: number = REGRESSION_FACTOR): number =>
  Math.max(before * factor, before + FLOOR_SPREAD_MS, NOISE_FLOOR_MS);

/** D-49's one rule for a noisy number: it regressed when it is past what `limitOf` allows. */
export const jumped = (
  value: number,
  before: number | undefined,
  factor: number = REGRESSION_FACTOR,
): boolean => before !== undefined && value > limitOf(before, factor);

/**
 * What is measured with a module busy is connections held, not requests served: the people are closed-loop clients
 * that send one request, wait for its answer and think for `BUSY_THINK_MS`, so the work they ask of the CPU is a
 * few tens of small requests a trial, and there are more of them than the pool has connections, so that were the
 * module not held to its share the pool would be theirs. The CPU and event loop a busy module takes are the process's
 * to share (`MODULES.md` §7) and are not what the share of the pool promises.
 */
const BUSY_PEOPLE = 12;
const BUSY_THINK_MS = 100;
/** A busy module's message or request is answered within this, or the scenario is broken: chat's queue is thirty seconds at most. */
const ANSWERED_WITHIN_MS = 60_000;
/**
 * A module's statements are made slow the way a long migration or a slow query would, without a clock in the
 * database: a lock on the table they read or write, taken for this long, let go for this long, again and again. The
 * people that got a slot hold a connection each for the whole of the lock.
 */
const LOCKED_MS = 800;
const UNLOCKED_MS = 50;
/** Trials with issues busy: the lower of two, since a slowdown the share causes is in both. */
const BUSY_TRIALS = 2;

/** The list of issues' hot path: a workspace of this many, read this many times a trial, this far apart. */
const ISSUES_LISTED = 50;
const READS_PER_TRIAL = 60;
const READ_PACE_MS = 50;

/** Under the per-connection and per-user budgets of ten a second (`rate-limiter.ts`). */
const PACE_MS = 125;
const READY_WITHIN_MS = 60_000;

export interface Latency {
  readonly ackP95Ms: number;
  readonly fanOutP95Ms: number;
  readonly messages: number;
  /** What the people reading issues were answered while the messages were timed; only when they were there. */
  readonly issues?: Tally;
  /** In a run's summary only: each other module's hot path with the others busy, by `<module>/<metric>` (`HOT_PATHS`). */
  readonly loaded?: Loaded;
}

/** What a request of a busy module was told: an answer, or its share's own refusal. */
export interface Tally {
  answered: number;
  refused: number;
}

/** One hot path's p95 while the others were busy: the lowest trial is what is judged, every trial is kept. */
interface LoadedPath {
  readonly p95Ms: number;
  readonly trials: readonly number[];
}
type Loaded = Readonly<Record<string, LoadedPath>>;

const LATENCY_TRIALS = 3;
const MESSAGES_PER_TRIAL = 60;

interface RepeatedLatency extends Latency {
  readonly trials: readonly Latency[];
}

/** Every trial is kept; the lowest p95 is chosen independently for ACK and delivery, and is what is judged (D-267). */
export const summarizeTrials = (trials: readonly Latency[]): RepeatedLatency => {
  if (
    trials.length !== LATENCY_TRIALS ||
    trials.some(
      (trial) =>
        trial.messages !== MESSAGES_PER_TRIAL ||
        !Number.isFinite(trial.ackP95Ms) ||
        trial.ackP95Ms <= 0 ||
        !Number.isFinite(trial.fanOutP95Ms) ||
        trial.fanOutP95Ms <= 0,
    )
  ) {
    throw new Error('three complete, finite latency trials of sixty messages are required');
  }
  return { ...lowestOf(trials), trials };
};

const range = (values: readonly number[]): string =>
  `${Math.min(...values).toFixed(1)} to ${Math.max(...values).toFixed(1)} ms`;

/** How far apart the trials were, which is how noisy the machine was while they ran. */
export const spreadOf = (trials: readonly Latency[]): string =>
  `noise across ${String(trials.length)} trials: ACK p95 ${range(trials.map((trial) => trial.ackP95Ms))}, fan-out p95 ${range(trials.map((trial) => trial.fanOutP95Ms))}`;

/** The value at the 95th percentile, nearest rank. */
export const p95 = (samples: readonly number[]): number => {
  if (samples.length === 0) throw new Error('no samples: nothing was measured');
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.NaN;
};

/** The lines to print, and whether the run regressed against the baseline, if there is one. */
export const judge = (
  now: Latency,
  baseline: Latency | null,
  factor: number = REGRESSION_FACTOR,
): { readonly regressed: boolean; readonly lines: readonly string[] } => {
  const rows = [
    ['ACK round-trip', now.ackP95Ms, baseline?.ackP95Ms, BUDGETS.ackMs],
    ['fan-out', now.fanOutP95Ms, baseline?.fanOutP95Ms, BUDGETS.fanOutMs],
  ] as const;
  let regressed = false;
  const chat = rows.map(([name, value, before, budget]) => {
    const worse = jumped(value, before, factor);
    if (worse) regressed = true;
    const against =
      before === undefined
        ? ''
        : `, was ${before.toFixed(1)} ms, limit ${limitOf(before, factor).toFixed(1)} ms`;
    const verdict = worse ? ' — REGRESSED' : value < budget ? '' : ' — over the budget';
    return `${name} p95: ${value.toFixed(1)} ms of ${String(budget)} ms (${String(now.messages)} messages${against})${verdict}`;
  });
  const loaded = Object.entries(now.loaded ?? {}).map(([name, path]) => {
    const before = baseline?.loaded?.[name]?.p95Ms;
    const worse = jumped(path.p95Ms, before, factor);
    if (worse) regressed = true;
    const against =
      before === undefined
        ? ', no number recorded yet'
        : `, was ${before.toFixed(1)} ms, limit ${limitOf(before, factor).toFixed(1)} ms`;
    return `${name} with the others busy p95: ${path.p95Ms.toFixed(1)} ms (${String(READS_PER_TRIAL)} reads${against})${worse ? ' — REGRESSED' : ''}`;
  });
  return { regressed, lines: [...chat, ...loaded] };
};

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  server.close();
  if (address === null || typeof address === 'string') throw new Error('no free port');
  return address.port;
};

interface Person {
  readonly id: string;
  readonly cookie: string;
}

const aPerson = async (clone: ClonedDatabase, secret: string, name: string): Promise<Person> => {
  const { id } = await clone.db
    .insertInto('users')
    .values({ email: `${name}@budget.test`, username: name, display_name: name })
    .returning('id')
    .executeTakeFirstOrThrow();
  const { token } = await issueSession(clone.db, systemClock, secret, id, 1);
  return { id, cookie: `${SESSION_COOKIE}=${token}` };
};

interface Socket {
  readonly send: (frame: unknown) => void;
  readonly frames: (
    listener: (frame: { event: string; data: unknown; refId?: string }) => void,
  ) => void;
  readonly close: () => void;
}

const connect = async (origin: string, cookie: string): Promise<Socket> => {
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws`, {
    headers: { cookie, origin },
  } as unknown as string[]);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('a socket did not open'));
    });
  });
  return {
    send: (frame): void => {
      socket.send(JSON.stringify(frame));
    },
    frames: (listener): void => {
      socket.addEventListener('message', (event) => {
        listener(
          JSON.parse(String(event.data)) as { event: string; data: unknown; refId?: string },
        );
      });
    },
    close: (): void => {
      socket.close();
    },
  };
};

/** Resolves when the frame that answers `id` arrives on the socket. */
const answered = (socket: Socket, id: string): Promise<void> =>
  new Promise((resolve) => {
    socket.frames((frame) => {
      if (frame.refId === id) resolve();
    });
  });

/**
 * What a reader of issues was told: an answer, or the share's own refusal of a request it has no room for, which
 * is expected and counted. Anything else is a defect of the scenario, not a number.
 */
export const countAnswer = (tally: { answered: number; refused: number }, status: number): void => {
  if (status === 200) tally.answered += 1;
  else if (status === 503) tally.refused += 1;
  else throw new Error(`issues answered ${String(status)}`);
};

/** A busy sender succeeds or is refused database capacity; any other answer invalidates the scenario. */
export const countSendAnswer = (tally: Tally, event: string, data: unknown): void => {
  const code: unknown =
    typeof data === 'object' && data !== null ? Reflect.get(data, 'code') : undefined;
  if (event === 'ACK') tally.answered += 1;
  else if (event === 'ERROR' && code === 'DATABASE_UNAVAILABLE') tally.refused += 1;
  else throw new Error(`chat answered ${event}${typeof code === 'string' ? `: ${code}` : ''}`);
};

/** A trial in which a message was not answered or not delivered measured nothing; it is an error, not a smaller sample. */
export const requireAnswers = (acks: number, deliveries: number, count: number): void => {
  if (acks < count || deliveries < count) {
    throw new Error(
      `answers missing: ${String(acks)} ACKs and ${String(deliveries)} deliveries of ${String(count)}`,
    );
  }
};

/** Everything a scenario needs of a running API: its address, its database, and the people and places in it. */
interface Scene {
  readonly origin: string;
  readonly clone: ClonedDatabase;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sender: Person;
  readonly listener: Person;
  /** A person of the workspace, signed in. */
  readonly member: (name: string) => Promise<Person>;
  /** A socket of the person's, closed with the scene. */
  readonly connect: (who: Person) => Promise<Socket>;
}

/**
 * Starts the API against a fresh clone, as the image starts it, with a workspace of two people and a channel they
 * are both in, and takes everything down afterwards.
 */
const inAScene = async <Result>(body: (scene: Scene) => Promise<Result>): Promise<Result> => {
  const clone = await cloneIntegrationDatabase();
  const port = await freePort();
  const origin = `http://localhost:${String(port)}`;
  // The server's key, so the sessions made below are signed as it signs them (D-179).
  const key = randomBytes(32).toString('base64');
  const api = Bun.spawn(['bun', '--no-env-file', 'apps/api/src/index.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      APP_URL: origin,
      DATABASE_URL: clone.connectionString,
      GITHUB_CLIENT_ID: 'budget',
      GITHUB_CLIENT_SECRET: 'budget',
      ENCRYPTION_KEY: key,
      LOG_LEVEL: 'warn',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const sockets: Socket[] = [];
  try {
    const deadline = performance.now() + READY_WITHIN_MS;
    for (;;) {
      const ready = await fetch(`${origin}/health/ready`).then(
        (response) => response.ok,
        () => false,
      );
      if (ready) break;
      if (performance.now() > deadline) throw new Error('the API did not become ready');
      await Bun.sleep(100);
    }
    const secret = deriveAuthSecret(key);
    const sender = await aPerson(clone, secret, 'budget-sender');
    const listener = await aPerson(clone, secret, 'budget-listener');
    const call = async (who: Person, path: string, body: unknown): Promise<{ id: string }> => {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { cookie: who.cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`${path} answered ${String(response.status)}`);
      return (await response.json()) as { id: string };
    };
    const slug = `budget-${randomBytes(4).toString('hex')}`;
    const workspace = await call(sender, '/api/workspaces', { name: 'budget', slug });
    const joinWorkspace = async (who: Person): Promise<void> => {
      await clone.db
        .insertInto('workspace_members')
        .values({ workspace_id: workspace.id, user_id: who.id, role: 'member' })
        .execute();
    };
    await joinWorkspace(listener);
    const channel = await call(sender, `/api/workspaces/${workspace.id}/channels`, {
      name: 'latency',
    });
    await call(listener, `/api/channels/${channel.id}/join`, {});
    return await body({
      origin,
      clone,
      workspaceId: workspace.id,
      channelId: channel.id,
      sender,
      listener,
      member: async (name) => {
        const who = await aPerson(clone, secret, name);
        await joinWorkspace(who);
        return who;
      },
      connect: async (who) => {
        const socket = await connect(origin, who.cookie);
        sockets.push(socket);
        return socket;
      },
    });
  } finally {
    for (const socket of sockets) socket.close();
    api.kill('SIGTERM');
    await api.exited;
    await clone.drop();
  }
};

/** What a module's hot path was timed to, by metric. */
type Samples = Readonly<Record<string, readonly number[]>>;

/** A module made busy: what its requests were told, and the way to let it go. */
interface Busy {
  readonly tally: Tally;
  readonly stop: () => Promise<void>;
}

/** Runs `loops` until stopped, which waits for them and says if one of them failed. */
export const busyWith = (
  tally: Tally,
  loops: (stopped: () => boolean) => readonly Promise<unknown>[],
): Busy => {
  let stopping = false;
  // Observe failures immediately, but drain every loop before surfacing one during cleanup.
  const running = Promise.allSettled(loops(() => stopping));
  return {
    tally,
    stop: async (): Promise<void> => {
      stopping = true;
      for (const outcome of await running) {
        if (outcome.status === 'rejected') {
          const error: unknown = outcome.reason;
          throw error;
        }
      }
    },
  };
};

/** Takes the table in turns, until `stopped`, so that the statements of the module that reads or writes it wait for it. */
const lockInTurns = async (
  clone: ClonedDatabase,
  table: 'issues' | 'messages',
  stopped: () => boolean,
): Promise<void> => {
  const lock = {
    issues: sql`lock table issues in access exclusive mode`,
    messages: sql`lock table messages in access exclusive mode`,
  }[table];
  while (!stopped()) {
    await clone.db.transaction().execute(async (transaction) => {
      await lock.execute(transaction);
      await Bun.sleep(LOCKED_MS);
    });
    await Bun.sleep(UNLOCKED_MS);
  }
};

/** Reads issues' list until `stopped`, one request at a time, thinking between them. */
const readIssues = async (
  scene: Scene,
  who: Person,
  stopped: () => boolean,
  tally: Tally,
): Promise<void> => {
  while (!stopped()) {
    const response = await fetch(`${scene.origin}/api/workspaces/${scene.workspaceId}/issues`, {
      headers: { cookie: who.cookie, origin: scene.origin },
    });
    await response.arrayBuffer();
    countAnswer(tally, response.status);
    await Bun.sleep(BUSY_THINK_MS);
  }
};

/**
 * Sends messages until `stopped`, one at a time with a pause after each answer. Only ACK and the database-capacity
 * refusal are valid answers; another error fails the scenario, as `countAnswer` does for issues.
 */
const sendMessages = async (
  scene: Scene,
  socket: Socket,
  stopped: () => boolean,
  tally: Tally,
): Promise<void> => {
  const outcomes = new Map<string, (event: string, data: unknown) => void>();
  socket.frames((frame) => {
    if (frame.refId !== undefined) outcomes.get(frame.refId)?.(frame.event, frame.data);
  });
  while (!stopped()) {
    const id = messageId(systemClock.now());
    await new Promise<void>((resolve, reject) => {
      const giveUp = setTimeout(() => {
        reject(new Error('chat did not answer a message while it was meant to be busy'));
      }, ANSWERED_WITHIN_MS);
      outcomes.set(id, (event, data) => {
        clearTimeout(giveUp);
        try {
          countSendAnswer(tally, event, data);
          resolve();
        } catch (error) {
          reject(
            error instanceof Error ? error : new Error('chat workload failed', { cause: error }),
          );
        }
      });
      socket.send({
        id,
        op: 'MESSAGE_SEND',
        payload: { channelId: scene.channelId, content: 'busy' },
      });
    });
    outcomes.delete(id);
    await Bun.sleep(BUSY_THINK_MS);
  }
};

/**
 * What a module declares for D-250 rule 6: how its hot path is timed (`prepare` readies the scene, `time` answers
 * every metric's samples, which are p95'd) and how it is made busy (`makeBusy`, lifting the other modules' hot paths
 * to their share), and which rule judges it: `quiet-and-starvation` is the send path's own (the quiet trials against the
 * baseline, then with issues busy against the quiet trials), `baseline` is the one a module added after chat has (its
 * hot path with the others busy, against the number recorded for it). A module with no hot path says why.
 */
type HotPath =
  | { readonly none: string }
  | {
      readonly judged: 'quiet-and-starvation' | 'baseline';
      readonly prepare: (scene: Scene) => Promise<(count: number) => Promise<Samples>>;
      readonly makeBusy: (scene: Scene) => Promise<Busy>;
    };

/** The send path: every message timed from the frame leaving to its `ACK` on the sender's socket and to its `MESSAGE_CREATED` on the other's. */
const timeSends = async (scene: Scene): Promise<(count: number) => Promise<Samples>> => {
  const out = await scene.connect(scene.sender);
  const into = await scene.connect(scene.listener);
  for (const socket of [out, into]) {
    const id = messageId(systemClock.now());
    const done = answered(socket, id);
    socket.send({
      id,
      op: 'SUBSCRIBE',
      payload: { channels: [{ channelId: scene.channelId, afterMessageId: null }] },
    });
    await done;
  }
  return async (count) => {
    const sentAt = new Map<string, number>();
    const acks: number[] = [];
    const fanOuts: number[] = [];
    out.frames((frame) => {
      const started = frame.refId === undefined ? undefined : sentAt.get(frame.refId);
      if (frame.event === 'ACK' && started !== undefined) acks.push(performance.now() - started);
    });
    into.frames((frame) => {
      const id = (frame.data as { id?: unknown } | null)?.id;
      const started = typeof id === 'string' ? sentAt.get(id) : undefined;
      if (frame.event === 'MESSAGE_CREATED' && started !== undefined) {
        fanOuts.push(performance.now() - started);
      }
    });
    for (let n = 0; n < count; n += 1) {
      const id = messageId(systemClock.now());
      sentAt.set(id, performance.now());
      out.send({
        id,
        op: 'MESSAGE_SEND',
        payload: { channelId: scene.channelId, content: `latency ${String(n)}` },
      });
      await Bun.sleep(PACE_MS);
    }
    const waitUntil = performance.now() + 10_000;
    while ((acks.length < count || fanOuts.length < count) && performance.now() < waitUntil) {
      await Bun.sleep(20);
    }
    requireAnswers(acks.length, fanOuts.length, count);
    return { ack: acks, fanOut: fanOuts };
  };
};

/**
 * The list of a workspace's issues, through its route, one request at a time; a request the share refuses is timed
 * at what it waited, since a module starved of its connections is what this measures, and counted by `countAnswer`.
 */
const timeIssuesList = async (scene: Scene): Promise<(count: number) => Promise<Samples>> => {
  for (let n = 0; n < ISSUES_LISTED; n += 1) {
    const response = await fetch(`${scene.origin}/api/workspaces/${scene.workspaceId}/issues`, {
      method: 'POST',
      headers: {
        cookie: scene.sender.cookie,
        origin: scene.origin,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: `latency ${String(n)}` }),
    });
    if (response.status !== 201)
      throw new Error(`creating an issue answered ${String(response.status)}`);
  }
  return async (count) => {
    const timed: number[] = [];
    const tally = { answered: 0, refused: 0 };
    for (let n = 0; n < count; n += 1) {
      const started = performance.now();
      const response = await fetch(`${scene.origin}/api/workspaces/${scene.workspaceId}/issues`, {
        headers: { cookie: scene.listener.cookie, origin: scene.origin },
      });
      await response.arrayBuffer();
      timed.push(performance.now() - started);
      countAnswer(tally, response.status);
      await Bun.sleep(READ_PACE_MS);
    }
    return { list: timed };
  };
};

/**
 * Issues busy: people reading its list throughout, from the same process and the same pool, while its table is
 * locked in turns, so that the readers that got a slot hold a connection each for the whole of the lock.
 */
const issuesBusy = async (scene: Scene): Promise<Busy> => {
  const readers = await Promise.all(
    Array.from({ length: BUSY_PEOPLE }, (_, n) => scene.member(`budget-reader-${String(n)}`)),
  );
  const tally = { answered: 0, refused: 0 };
  return busyWith(tally, (stopped) => [
    lockInTurns(scene.clone, 'issues', stopped),
    ...readers.map((reader) => readIssues(scene, reader, stopped, tally)),
  ]);
};

/** Chat busy: people sending messages throughout, more of them than chat's share of the pool, while its messages are locked in turns. */
const chatBusy = async (scene: Scene): Promise<Busy> => {
  const senders = await Promise.all(
    Array.from({ length: BUSY_PEOPLE }, async (_, n) => {
      const who = await scene.member(`budget-chatter-${String(n)}`);
      const response = await fetch(`${scene.origin}/api/channels/${scene.channelId}/join`, {
        method: 'POST',
        headers: { cookie: who.cookie, origin: scene.origin, 'content-type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error(`joining the channel answered ${String(response.status)}`);
      return await scene.connect(who);
    }),
  );
  const tally = { answered: 0, refused: 0 };
  return busyWith(tally, (stopped) => [
    lockInTurns(scene.clone, 'messages', stopped),
    ...senders.map((socket) => sendMessages(scene, socket, stopped, tally)),
  ]);
};

/** Every bundled module's hot path, or why it has none; `budget-latency.test.ts` holds the keys to the bundle. */
export const HOT_PATHS: Readonly<Record<ModuleId, HotPath>> = {
  chat: { judged: 'quiet-and-starvation', prepare: timeSends, makeBusy: chatBusy },
  issues: { judged: 'baseline', prepare: timeIssuesList, makeBusy: issuesBusy },
};

/**
 * Times `subject`'s hot path with each of the `busy` modules made busy before it starts, and takes everything down;
 * says what the busy ones were told. A busy module that nobody answered measured nothing, and is an error.
 */
export const measureUnder = async (
  subject: ModuleId,
  count: number,
  busy: readonly ModuleId[],
): Promise<{ readonly samples: Samples; readonly busy: Partial<Record<ModuleId, Tally>> }> =>
  await inAScene(async (scene) => {
    const timed = HOT_PATHS[subject];
    if ('none' in timed) throw new Error(`${subject} has no hot path: ${timed.none}`);
    const time = await timed.prepare(scene);
    const loads: [ModuleId, Busy][] = [];
    try {
      for (const id of busy) {
        const load = HOT_PATHS[id];
        if (!('none' in load)) loads.push([id, await load.makeBusy(scene)]);
      }
      const samples = await time(count);
      for (const [, load] of loads) await load.stop();
      for (const [id, load] of loads) {
        if (load.tally.answered === 0) {
          throw new Error(
            `nobody was answered while ${id} was meant to be busy: nothing was measured`,
          );
        }
      }
      return { samples, busy: Object.fromEntries(loads.map(([id, load]) => [id, load.tally])) };
    } finally {
      await Promise.all(loads.map(([, load]) => load.stop().catch(() => undefined)));
    }
  });

/** Chat's latency, `count` messages; with `issuesBusy`, while people read issues' list throughout. */
export const measureLatency = async (count: number, issuesBusy = false): Promise<Latency> => {
  const { samples, busy } = await measureUnder('chat', count, issuesBusy ? ['issues'] : []);
  return {
    ackP95Ms: p95(samples['ack'] ?? []),
    fanOutP95Ms: p95(samples['fanOut'] ?? []),
    messages: count,
    ...(busy.issues === undefined ? {} : { issues: busy.issues }),
  };
};

/** The p95 of each metric of `subject`'s hot path, `count` requests, while every other module is busy, and what the busy ones were told. */
export type LoadedMeasure = (
  subject: ModuleId,
  count: number,
) => Promise<{
  readonly p95: Readonly<Record<string, number>>;
  readonly busy: Partial<Record<ModuleId, Tally>>;
}>;

const measureLoaded: LoadedMeasure = async (subject, count) => {
  const others = MODULE_IDS.filter((id) => id !== subject);
  const { samples, busy } = await measureUnder(subject, count, others);
  return {
    p95: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, p95(values)])),
    busy,
  };
};

export const optionOf = (args: readonly string[], name: string): string | undefined => {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
};

/** A kept measurement, read back; anything else is refused rather than compared with nothing. */
const readLatency = async (file: string): Promise<Latency> => {
  const read: unknown = await Bun.file(file).json();
  const field = (name: keyof Latency): number | null => {
    const value: unknown =
      typeof read === 'object' && read !== null ? Reflect.get(read, name) : null;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const ackP95Ms = field('ackP95Ms');
  const fanOutP95Ms = field('fanOutP95Ms');
  const messages = field('messages');
  if (ackP95Ms === null || fanOutP95Ms === null || messages === null) {
    throw new Error(`${file} is not a latency measurement`);
  }
  const loaded: unknown =
    typeof read === 'object' && read !== null ? Reflect.get(read, 'loaded') : null;
  return { ackP95Ms, fanOutP95Ms, messages, ...(isLoaded(loaded) ? { loaded } : {}) };
};

/** A recorded `loaded`; one that is not in this shape (a baseline from before it existed) is not compared. */
const isLoaded = (value: unknown): value is Loaded =>
  typeof value === 'object' &&
  value !== null &&
  Object.values(value).every(
    (path: unknown) =>
      typeof path === 'object' &&
      path !== null &&
      typeof Reflect.get(path, 'p95Ms') === 'number' &&
      Number.isFinite(Reflect.get(path, 'p95Ms')),
  );

/**
 * Every module's hot path judged on the baseline, with the others busy: three trials each, the lowest kept beside every
 * trial (D-267). What is not a finite positive number is an error, as for the quiet trials.
 */
const measureLoadedPaths = async (
  measure: LoadedMeasure,
): Promise<{ readonly loaded: Loaded; readonly told: readonly string[] }> => {
  const loaded: Record<string, LoadedPath> = {};
  const told: string[] = [];
  for (const [id, path] of Object.entries(HOT_PATHS)) {
    if ('none' in path || path.judged !== 'baseline') continue;
    const trials: Readonly<Record<string, number>>[] = [];
    for (let trial = 0; trial < LATENCY_TRIALS; trial += 1) {
      const { p95: measured, busy } = await measure(id as ModuleId, READS_PER_TRIAL);
      trials.push(measured);
      for (const [other, tally] of Object.entries(busy)) {
        told.push(
          `${id} trial ${String(trial + 1)}/${String(LATENCY_TRIALS)}: ${other} answered ${String(tally.answered)}, refused ${String(tally.refused)}`,
        );
      }
    }
    for (const metric of Object.keys(trials[0] ?? {})) {
      const values = trials.map((trial) => trial[metric] ?? Number.NaN);
      if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
        throw new Error(`${id}/${metric}: three finite positive p95s are required`);
      }
      loaded[`${id}/${metric}`] = { p95Ms: Math.min(...values), trials: values };
    }
  }
  return { loaded, told };
};

/** The command: measure, compare with `--baseline`, keep with `--record`; answers what to print and the exit code. */
export const main = async (
  args: readonly string[],
  measure: (count: number) => Promise<Latency> = measureLatency,
  measureLoadedPath?: LoadedMeasure,
): Promise<{
  readonly lines: readonly string[];
  readonly code: number;
  /** What the quiet trials came to, for the trials with issues busy to be judged against. */
  readonly quiet: Latency;
}> => {
  const keepFile = optionOf(args, '--keep');
  const firstKept = keepFile !== undefined && !(await Bun.file(keepFile).exists());
  const baselineFile = firstKept ? undefined : (keepFile ?? optionOf(args, '--baseline'));
  const recordFile = optionOf(args, '--record');
  const baseline = baselineFile === undefined ? null : await readLatency(baselineFile);
  const measured = async (): Promise<{
    readonly now: RepeatedLatency;
    readonly regressed: boolean;
    readonly lines: readonly string[];
  }> => {
    const trials: Latency[] = [];
    for (let trial = 0; trial < LATENCY_TRIALS; trial += 1) {
      trials.push(await measure(MESSAGES_PER_TRIAL));
    }
    const { loaded, told } =
      measureLoadedPath === undefined
        ? { loaded: {}, told: [] }
        : await measureLoadedPaths(measureLoadedPath);
    const now: RepeatedLatency = {
      ...summarizeTrials(trials),
      ...(Object.keys(loaded).length === 0 ? {} : { loaded }),
    };
    const verdict = judge(now, baseline);
    const detail = trials.map(
      (trial, index) =>
        `trial ${String(index + 1)}/${String(LATENCY_TRIALS)}: ACK p95 ${trial.ackP95Ms.toFixed(1)} ms, fan-out p95 ${trial.fanOutP95Ms.toFixed(1)} ms (${String(trial.messages)} messages)`,
    );
    return {
      now,
      regressed: verdict.regressed,
      lines: [
        ...verdict.lines,
        'verdict: lowest of three independent p95 measurements',
        spreadOf(trials),
        ...Object.entries(loaded).map(
          ([name, path]) =>
            `noise across ${String(path.trials.length)} trials: ${name} p95 ${range(path.trials)}`,
        ),
        ...detail,
        ...told,
      ],
    };
  };
  let { now, regressed, lines } = await measured();
  // A regression must happen twice (D-227): a sustained slowdown shows again in three more trials, a
  // runner's bad minute does not. Once, never until a pass; an interrupted trial is still an error.
  if (regressed) {
    const again = await measured();
    ({ now, regressed } = again);
    lines = [...lines, 'first measurement regressed; measured again:', ...again.lines];
  }
  // What is recorded is what was judged last, so the record and the verdict are the same run.
  const write = async (file: string): Promise<void> => {
    await Bun.write(file, `${JSON.stringify(now, null, 2)}\n`);
  };
  if (recordFile !== undefined) await write(recordFile);
  // A regression is not adopted: the next run is judged against the last one that passed.
  if (keepFile !== undefined && !regressed) await write(keepFile);
  const said = firstKept ? ['no baseline yet: this run is recorded, nothing compared'] : [];
  return { lines: [...said, ...lines], code: regressed ? 1 : 0, quiet: now };
};

/** The lowest p95 of each metric across the trials: what the code does when it is not a stall that slows it. */
export const lowestOf = (trials: readonly Latency[]): Latency => ({
  ackP95Ms: Math.min(...trials.map((trial) => trial.ackP95Ms)),
  fanOutP95Ms: Math.min(...trials.map((trial) => trial.fanOutP95Ms)),
  messages: MESSAGES_PER_TRIAL,
});

/**
 * Chat's latency with issues busy, against the quiet trials of the same run: the trials again, each with people
 * reading issues' list throughout, the lower of the two judged by `judge` at `STARVATION_FACTOR` — past it and the noise floor is
 * starvation — and measured once more if it regressed, as D-227 has it. Trials in which nobody was answered are an error: a
 * measurement with nothing busy proves nothing.
 */
export const withIssuesBusy = async (
  quiet: Latency,
  measure: (count: number, issuesBusy: boolean) => Promise<Latency> = measureLatency,
): Promise<{ readonly regressed: boolean; readonly lines: readonly string[] }> => {
  const once = async (): Promise<{
    readonly regressed: boolean;
    readonly lines: readonly string[];
  }> => {
    const trials: Latency[] = [];
    for (let trial = 0; trial < BUSY_TRIALS; trial += 1) {
      const latency = await measure(MESSAGES_PER_TRIAL, true);
      if ((latency.issues?.answered ?? 0) === 0) {
        throw new Error(
          'nobody was answered while issues were meant to be busy: nothing was measured',
        );
      }
      trials.push(latency);
    }
    const lowest = lowestOf(trials);
    const verdict = judge(lowest, quiet, STARVATION_FACTOR);
    const detail = trials.map(
      (trial, index) =>
        `trial ${String(index + 1)}/${String(BUSY_TRIALS)}: ACK p95 ${trial.ackP95Ms.toFixed(1)} ms, fan-out p95 ${trial.fanOutP95Ms.toFixed(1)} ms; issues answered ${String(trial.issues?.answered)}, refused ${String(trial.issues?.refused)}`,
    );
    const ratios = `ratio to the quiet p95: ACK ${(lowest.ackP95Ms / quiet.ackP95Ms).toFixed(1)}x, fan-out ${(lowest.fanOutP95Ms / quiet.fanOutP95Ms).toFixed(1)}x; starved past ${String(STARVATION_FACTOR)}x`;
    return { regressed: verdict.regressed, lines: [...verdict.lines, ratios, ...detail] };
  };
  const first = await once();
  const heading = 'with issues busy, against the quiet trials of this run:';
  if (!first.regressed) return { regressed: false, lines: [heading, ...first.lines] };
  const again = await once();
  return {
    regressed: again.regressed,
    lines: [
      heading,
      ...first.lines,
      'first measurement with issues busy regressed; measured again:',
      ...again.lines,
    ],
  };
};

/**
 * The whole gate: the quiet trials and each other module's hot path with the others busy, against the baseline; then
 * chat with issues busy against the quiet trials.
 */
export const gate = async (
  args: readonly string[],
  measure: (count: number, issuesBusy: boolean) => Promise<Latency> = measureLatency,
  measureLoadedPath: LoadedMeasure = measureLoaded,
): Promise<{ readonly lines: readonly string[]; readonly code: number }> => {
  const quiet = await main(args, (count) => measure(count, false), measureLoadedPath);
  const busy = await withIssuesBusy(quiet.quiet, measure);
  return {
    lines: [...quiet.lines, ...busy.lines],
    code: quiet.code === 0 && !busy.regressed ? 0 : 1,
  };
};

if (import.meta.main) {
  const { lines, code } = await gate(process.argv.slice(2));
  for (const line of lines) console.log(line);
  process.exit(code);
}
