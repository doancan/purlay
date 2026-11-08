/**
 * A node of a cluster as an operating system sees it: the API's own entry point started as a process of its own, with its own
 * memory, its own boot and its own signals, on a database and a Redis that other nodes share. What the two-process tests of
 * the cluster (D-288, D-289, D-292) start, wait for and stop.
 *
 * What a test changes about a node it changes in a preload (`node-without-grants-preload.ts`, `node-with-wiki-preload.ts`):
 * a file that runs before the entry point in the same process and touches no line of what ships.
 */
import { join } from 'node:path';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../platform/config';

export interface ClusterNode {
  readonly process: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  readonly port: number;
  /** The address the node serves under, which is also the origin it accepts a write from. */
  readonly origin: string;
  /** Everything the node has written to its standard output and error so far. */
  readonly said: () => string;
}

export interface ClusterNodeOptions {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  /** The namespace of the cluster in Redis: a node of another namespace is another cluster. */
  readonly redisPrefix: string;
  /** Files that run before the entry point, in order. */
  readonly preloads?: readonly string[];
  /** What a preload reads. */
  readonly env?: Readonly<Record<string, string>>;
}

const ENTRY_POINT = join(import.meta.dir, '../index.ts');

export const preloadFile = (name: string): string => join(import.meta.dir, name);

const freePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = probe.port ?? 0;
  void probe.stop(true);
  return port;
};

/** A unique namespace for one run of one test: two runs on the same Redis never read each other's records. */
export const aClusterNamespace = (): string =>
  `n-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;

export const startClusterNode = (options: ClusterNodeOptions): ClusterNode => {
  const port = freePort();
  const origin = `http://localhost:${String(port)}`;
  const preloads = (options.preloads ?? []).flatMap((file) => ['--preload', file]);
  const child = Bun.spawn(['bun', '--no-env-file', ...preloads, ENTRY_POINT], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env['PATH'] ?? '',
      NODE_ENV: 'development',
      PORT: String(port),
      APP_URL: origin,
      DATABASE_URL: options.databaseUrl,
      REDIS_URL: options.redisUrl,
      REDIS_KEY_PREFIX: options.redisPrefix,
      ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY,
      GITHUB_CLIENT_ID: 'id',
      GITHUB_CLIENT_SECRET: 'secret',
      // Whoever signs in may make a workspace, as the tests that make several of them need.
      WORKSPACE_CREATORS: '*',
      ...options.env,
    },
  });
  let output = '';
  // Read until the process ends, or a full pipe would stop it.
  for (const stream of [child.stdout, child.stderr]) {
    void (async (): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) output += decoder.decode(chunk);
    })();
  }
  return { process: child, port, origin, said: () => output };
};

const readyStatus = async (node: ClusterNode): Promise<number> =>
  await fetch(`${node.origin}/health/ready`).then(
    (response) => response.status,
    () => 0,
  );

/** Waits for what is expected to be true, and says what, rather than for a time to pass. */
export const eventually = async (
  what: string | (() => string),
  holds: () => boolean | Promise<boolean>,
  withinMs: number,
): Promise<void> => {
  const started = performance.now();
  while (performance.now() - started < withinMs) {
    if (await holds()) return;
    await Bun.sleep(50);
  }
  throw new Error(
    `within ${String(withinMs)} ms, never: ${typeof what === 'string' ? what : what()}`,
  );
};

export const untilReady = async (node: ClusterNode, withinMs: number): Promise<void> => {
  await eventually(
    () => `a node is ready; it said: ${node.said().slice(-600)}`,
    async () => node.process.exitCode === null && (await readyStatus(node)) === 200,
    withinMs,
  );
};

/** Ends every node that is still running, and waits until it is gone: no test leaves a process behind. */
export const killClusterNodes = async (nodes: readonly ClusterNode[]): Promise<void> => {
  for (const node of nodes) if (node.process.exitCode === null) node.process.kill('SIGKILL');
  await Promise.all(nodes.map(async (node) => await node.process.exited));
};
