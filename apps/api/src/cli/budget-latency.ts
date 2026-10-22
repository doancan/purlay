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
 * **It blocks on a regression, never on the line** (D-49): a p95 on a shared machine moves by tens of
 * percent between identical runs, and a gate people learn to re-run has stopped being a gate. So with a
 * baseline it fails when a p95 is more than `REGRESSION_FACTOR` times the recorded one *and* past the
 * budget's floor of interest; without one it reports, with the budget beside each number.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { cloneIntegrationDatabase, type ClonedDatabase } from '@purlay/db';
import { messageId } from '@purlay/types';
import { systemClock } from '../platform/clock';
import { SESSION_COOKIE } from '../platform/cookies';
import { issueSession } from '../modules/auth/sessions';
import { deriveAuthSecret } from '../modules/auth/better-auth';

export const BUDGETS = { ackMs: 120, fanOutMs: 200 } as const;
/** A jump: this many times the recorded p95. */
export const REGRESSION_FACTOR = 1.5;
/** Below this a jump is noise: a p95 of 4 ms becoming 7 ms is not a regression anyone feels. */
const NOISE_FLOOR_MS = 20;

/** D-49's one rule for a noisy number: it regressed when it is past both the factor and the floor. */
export const jumped = (value: number, before: number | undefined): boolean =>
  before !== undefined && value > Math.max(before * REGRESSION_FACTOR, NOISE_FLOOR_MS);

/** Under the per-connection and per-user budgets of ten a second (`rate-limiter.ts`). */
const PACE_MS = 125;
const READY_WITHIN_MS = 60_000;

export interface Latency {
  readonly ackP95Ms: number;
  readonly fanOutP95Ms: number;
  readonly messages: number;
}

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
): { readonly regressed: boolean; readonly lines: readonly string[] } => {
  const rows = [
    ['ACK round-trip', now.ackP95Ms, baseline?.ackP95Ms, BUDGETS.ackMs],
    ['fan-out', now.fanOutP95Ms, baseline?.fanOutP95Ms, BUDGETS.fanOutMs],
  ] as const;
  let regressed = false;
  const lines = rows.map(([name, value, before, budget]) => {
    const worse = jumped(value, before);
    if (worse) regressed = true;
    const against = before === undefined ? '' : `, was ${before.toFixed(1)} ms`;
    const verdict = worse ? ' — REGRESSED' : value < budget ? '' : ' — over the budget';
    return `${name} p95: ${value.toFixed(1)} ms of ${String(budget)} ms (${String(now.messages)} messages${against})${verdict}`;
  });
  return { regressed, lines };
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

/** Starts the API against a fresh clone, times `count` messages, and takes everything down. */
export const measureLatency = async (count: number): Promise<Latency> => {
  const clone = await cloneIntegrationDatabase();
  const port = await freePort();
  const origin = `http://localhost:${String(port)}`;
  // The server's key, so the sessions made below are signed as it signs them (D-179).
  const key = randomBytes(32).toString('base64');
  const api = Bun.spawn(['bun', 'apps/api/src/index.ts'], {
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
    const sender = await aPerson(clone, deriveAuthSecret(key), 'budget-sender');
    const listener = await aPerson(clone, deriveAuthSecret(key), 'budget-listener');
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
    await clone.db
      .insertInto('workspace_members')
      .values({ workspace_id: workspace.id, user_id: listener.id, role: 'member' })
      .execute();
    const channel = await call(sender, `/api/workspaces/${workspace.id}/channels`, {
      name: 'latency',
    });
    await call(listener, `/api/channels/${channel.id}/join`, {});

    const out = await connect(origin, sender.cookie);
    const into = await connect(origin, listener.cookie);
    sockets.push(out, into);
    for (const socket of [out, into]) {
      const id = messageId(systemClock.now());
      const done = answered(socket, id);
      socket.send({
        id,
        op: 'SUBSCRIBE',
        payload: { channels: [{ channelId: channel.id, afterMessageId: null }] },
      });
      await done;
    }

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
        payload: { channelId: channel.id, content: `latency ${String(n)}` },
      });
      await Bun.sleep(PACE_MS);
    }
    const waitUntil = performance.now() + 10_000;
    while ((acks.length < count || fanOuts.length < count) && performance.now() < waitUntil) {
      await Bun.sleep(20);
    }
    if (acks.length < count || fanOuts.length < count) {
      throw new Error(
        `answers missing: ${String(acks.length)} ACKs and ${String(fanOuts.length)} deliveries of ${String(count)}`,
      );
    }
    return { ackP95Ms: p95(acks), fanOutP95Ms: p95(fanOuts), messages: count };
  } finally {
    for (const socket of sockets) socket.close();
    api.kill('SIGTERM');
    await api.exited;
    await clone.drop();
  }
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
  return { ackP95Ms, fanOutP95Ms, messages };
};

/** The command: measure, compare with `--baseline`, keep with `--record`; answers what to print and the exit code. */
export const main = async (
  args: readonly string[],
  measure: (count: number) => Promise<Latency> = measureLatency,
): Promise<{ readonly lines: readonly string[]; readonly code: number }> => {
  const keepFile = optionOf(args, '--keep');
  const firstKept = keepFile !== undefined && !(await Bun.file(keepFile).exists());
  const baselineFile = firstKept ? undefined : (keepFile ?? optionOf(args, '--baseline'));
  const recordFile = optionOf(args, '--record');
  const baseline = baselineFile === undefined ? null : await readLatency(baselineFile);
  const now = await measure(60);
  const { regressed, lines } = judge(now, baseline);
  const write = async (file: string): Promise<void> => {
    await Bun.write(file, `${JSON.stringify(now, null, 2)}\n`);
  };
  if (recordFile !== undefined) await write(recordFile);
  // A regression is not adopted: the next run is judged against the last one that passed.
  if (keepFile !== undefined && !regressed) await write(keepFile);
  const said = firstKept ? ['no baseline yet: this run is recorded, nothing compared'] : [];
  return { lines: [...said, ...lines], code: regressed ? 1 : 0 };
};

if (import.meta.main) {
  const { lines, code } = await main(process.argv.slice(2));
  for (const line of lines) console.log(line);
  process.exit(code);
}
