/**
 * Which databases on the test server are scratch, and what `bun run db:prune` does with them. The
 * command itself (`prune-databases.ts`) only connects; everything that could be wrong is here, where a
 * test reads it.
 *
 * A run drops what it made when it ends; one that is killed (a stopped terminal, a restarted Docker)
 * does not, and a developer's server collects hundreds. **Dry by default**, and an allow-list of the
 * shapes this project's own tools make — never a guess, never the database the URL names, never the
 * developer's own (`purlay_live`) or anyone else's on the same server.
 */
const SCRATCH: readonly RegExp[] = [
  // `cloneIntegrationDatabase`: `<database>_<twelve hex>`, and the template it clones.
  /^purlay_[0-9a-f]{12}$/,
  /^purlay_template$/,
  // The demo, the browser suite's worlds and the wizard's fresh server (`scripts/demo.ts`).
  /^purlay_(demo|e2e)[a-z0-9_]*$/,
  // The harness's own tests.
  /^purlay_(preload_probe|harness_stale)_[a-z0-9_]+$/,
  // A named verify run (`purlay_<name>_verify`, with the template its clones come from).
  /^purlay_[a-z0-9]+(?:_[a-z0-9]+)*_verify(?:_template)?$/,
];

/** The names a prune may drop, in the order given; never `configured`, however it is spelled. */
export const scratchDatabases = (names: readonly string[], configured: string): string[] =>
  names.filter((name) => name !== configured && SCRATCH.some((shape) => shape.test(name)));

/** The server a prune talks to: what it has, and what it is told to drop. */
export interface DatabaseServer {
  readonly databases: () => Promise<string[]>;
  /** The databases somebody is connected to now: a run of another session, not a leftover. */
  readonly inUse: () => Promise<string[]>;
  readonly drop: (names: readonly string[]) => Promise<void>;
}

/** Lists the scratch databases, or — when `drop` — drops them, all at once, and says which. */
export const prune = async (
  server: DatabaseServer,
  configured: string,
  drop: boolean,
  say: (line: string) => void,
): Promise<void> => {
  const scratch = scratchDatabases(await server.databases(), configured);
  // A drop is `with (force)`, which would end a run that is using the database: what is connected to
  // is left, whatever it is called — the leftovers of a killed run have no one connected.
  const connected = new Set(await server.inUse());
  const doomed = scratch.filter((name) => !connected.has(name));
  const left = scratch.length - doomed.length;
  const note = left === 0 ? '' : `; ${String(left)} in use, left alone`;
  if (doomed.length === 0) {
    say(`no scratch databases${note}`);
  } else if (!drop) {
    say(doomed.join('\n'));
    say(
      `\n${String(doomed.length)} scratch databases${note}; \`bun run db:prune -- --drop\` drops them.`,
    );
  } else {
    await server.drop(doomed);
    say(`dropped ${String(doomed.length)} scratch databases${note}`);
  }
};
