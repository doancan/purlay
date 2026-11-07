/**
 * The edition file (D-292): which workspaces get which modules, as config in a file, read by `bun run entitlements:apply`.
 *
 * ```json
 * { "editions": { "team": ["chat", "issues"], "business": ["chat", "issues", "tasks"] },
 *   "workspaces": { "acme": { "edition": "business", "validUntil": "2027-01-01T00:00:00Z" } } }
 * ```
 *
 * An edition is a name that lives here and nowhere else; the table says modules only. A listed workspace is given each module of the
 * build it can be granted: `on` if its edition lists it (until `validUntil`, when there is one) and `off` if not, so what the file says
 * is what the workspace has, whichever mode the server is in. A workspace the file does not list is left as it is.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Timestamp } from '@purlay/types';
import type { Executor, Transaction } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { atomicallyOn } from '../../platform/transactions';
import {
  applyEntitlements,
  type EntitlementCatalogue,
  type EntitlementChange,
  type EntitlementWrite,
} from './apply';

const MODULE_ID = '^[a-z][a-z0-9-]{0,31}$';

export const EditionFile = Type.Object(
  {
    editions: Type.Record(
      Type.String({ minLength: 1, maxLength: 48 }),
      Type.Array(Type.String({ pattern: MODULE_ID })),
    ),
    workspaces: Type.Record(
      Type.String({ minLength: 1, maxLength: 64 }),
      Type.Object(
        { edition: Type.String(), validUntil: Type.Optional(Timestamp) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type EditionFile = Static<typeof EditionFile>;

/** What is wrong with the text of an edition file, in words an operator can act on; empty when it is a file. */
export const readEditionFile = (text: string): { file?: EditionFile; problems: string[] } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problems: ['it is not JSON'] };
  }
  if (Value.Check(EditionFile, parsed)) return { file: parsed, problems: [] };
  return {
    problems: [...Value.Errors(EditionFile, parsed)].map(
      (error) => `${error.path === '' ? 'the file' : error.path}: ${error.message}`,
    ),
  };
};

/** The writes the file asks for, or every reason it cannot be applied: nothing is applied from a file with a problem. */
export const planEdition = (
  file: EditionFile,
  catalogue: EntitlementCatalogue,
  workspaceIds: ReadonlyMap<string, string>,
  now: Date,
): { writes: EntitlementWrite[]; problems: string[] } => {
  const problems: string[] = [];
  const grantable = catalogue.carried.filter(({ entitlement }) => entitlement !== 'always');
  for (const [name, modules] of Object.entries(file.editions)) {
    for (const module of modules) {
      if (!catalogue.carried.some(({ id }) => id === module))
        problems.push(`edition "${name}" lists "${module}", which this build does not carry`);
    }
  }
  const writes: EntitlementWrite[] = [];
  for (const [slug, { edition, validUntil }] of Object.entries(file.workspaces)) {
    const modules = file.editions[edition];
    const workspaceId = workspaceIds.get(slug);
    if (modules === undefined)
      problems.push(
        `workspace "${slug}" names the edition "${edition}", which the file does not define`,
      );
    if (workspaceId === undefined) problems.push(`there is no workspace "${slug}"`);
    if (validUntil !== undefined && new Date(validUntil).getTime() <= now.getTime())
      problems.push(`workspace "${slug}": validUntil has passed`);
    if (modules === undefined || workspaceId === undefined) continue;
    for (const { id } of grantable) {
      writes.push(
        modules.includes(id)
          ? {
              workspaceId,
              module: id,
              state: 'on',
              ...(validUntil === undefined ? {} : { validUntil: new Date(validUntil) }),
            }
          : { workspaceId, module: id, state: 'off' },
      );
    }
  }
  return { writes, problems };
};

/** Raised inside the transaction of a dry run, which is made and then undone. */
class DryRun extends Error {
  readonly changes: readonly EntitlementChange[];
  constructor(changes: readonly EntitlementChange[]) {
    super('dry run');
    this.changes = changes;
  }
}

/**
 * Applies the writes in one transaction, or only finds out what they would change: the transaction is made and undone, so a dry
 * run refuses what the real one would, `MODULE_REQUIRES` included.
 */
export const applyEdition = async (
  database: Executor,
  clock: Clock,
  catalogue: EntitlementCatalogue,
  source: string,
  writes: readonly EntitlementWrite[],
  dryRun: boolean,
): Promise<readonly EntitlementChange[]> => {
  const run = async (tx: Transaction): Promise<readonly EntitlementChange[]> => {
    const changes = await applyEntitlements(tx, clock, catalogue, { source, userId: null }, writes);
    if (dryRun) throw new DryRun(changes);
    return changes;
  };
  try {
    return await atomicallyOn(database)(run);
  } catch (error) {
    if (error instanceof DryRun) return error.changes;
    throw error;
  }
};
