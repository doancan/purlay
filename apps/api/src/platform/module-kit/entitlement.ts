/**
 * Which of the modules a process runs a workspace may use (D-289): one pure function, so that the guard of a request, the
 * lists a session is sent, the search, the inbox, the workers and the outbox all ask the same question and get the same
 * answer. No I/O and no environment, as the rest of this folder.
 *
 * The set is `closure_requires((running − suspended) ∩ granted(workspace))`. A suspended module (D-296) is one the server's
 * administrator stopped for every workspace at once, whatever a workspace is granted, and `always` modules are not spared it. A module that declares `entitlement: 'always'` is not a
 * thing a workspace is granted (chat, in the first release of this: its sockets are not closed per workspace yet); every
 * other module is a grant. What a workspace with no row gets is the server's mode: `open` is on (a server you run yourself
 * runs everything it has), `managed` is off (a module that appears in a later release is not given to every customer unseen).
 */
import type { ModuleManifest } from './manifest';

/** What a workspace with no row for a module is granted: `open` is the module, `managed` is nothing. */
export type EntitlementMode = 'open' | 'managed';

/** One row of `workspace_modules`: the operator's word for one workspace and one module. */
export interface EntitlementRow {
  readonly module: string;
  readonly state: 'on' | 'off';
  /** Until when the row counts; `null` is for good. A row at or past it is read as no row. */
  readonly validUntil: Date | null;
}

/** The part of a manifest that decides the set. */
export type EntitlementCandidate = Pick<ModuleManifest, 'id' | 'requires' | 'entitlement'>;

export interface EffectiveModulesInput {
  /** The modules this process runs, in the registry's order. */
  readonly running: readonly EntitlementCandidate[];
  /** The workspace's rows; one for a module the build does not carry is ignored. */
  readonly rows: readonly EntitlementRow[];
  readonly mode: EntitlementMode;
  /** When the rows are read, which the rows' `validUntil` is judged against. */
  readonly now: Date;
  /** The modules stopped for the whole server (D-296); left out, none. They leave the set, and what requires them leaves with them. */
  readonly suspended?: ReadonlySet<string>;
}

const rowCounts = (row: EntitlementRow, now: Date): boolean =>
  row.validUntil === null || row.validUntil.getTime() > now.getTime();

/** Whether a module is granted to the workspace on its own, before what it requires is looked at. */
const granted = (
  candidate: EntitlementCandidate,
  rows: readonly EntitlementRow[],
  mode: EntitlementMode,
  now: Date,
): boolean => {
  if (candidate.entitlement === 'always') return true;
  const own = rows.filter((row) => row.module === candidate.id && rowCounts(row, now));
  // `off` wins over `on` should a caller ever hand two rows for one module: the table's key forbids it, and a refusal is the safe reading.
  if (own.some((row) => row.state === 'off')) return false;
  if (own.some((row) => row.state === 'on')) return true;
  return mode === 'open';
};

/**
 * What a request is given to judge its workspace's grants with (`RequestScope.entitlements`): the set for the rows just read, and
 * what to do when a request is turned away for them. The composition makes the first (`Composition.effectiveModules`); whoever
 * starts the request names the second, because counting is the transport's.
 */
export interface EntitlementPolicy {
  readonly effective: (rows: readonly EntitlementRow[], now: Date) => ReadonlySet<string>;
  readonly refused: (module: string) => void;
}

export const effectiveModules = ({
  running,
  rows,
  mode,
  now,
  suspended,
}: EffectiveModulesInput): ReadonlySet<string> => {
  const effective = new Set(
    running
      .filter((candidate) => suspended?.has(candidate.id) !== true)
      .filter((candidate) => granted(candidate, rows, mode, now))
      .map(({ id }) => id),
  );
  // A module whose requirement is not in the set goes too, and what requires that goes in turn: until nothing moves.
  let dropped = true;
  while (dropped) {
    dropped = false;
    for (const { id, requires } of running) {
      if (effective.has(id) && !requires.every((required) => effective.has(required))) {
        effective.delete(id);
        dropped = true;
      }
    }
  }
  return effective;
};
