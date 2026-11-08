/**
 * The one writer of `suspended_modules` (D-296): the administration console and the `module:suspend` and `module:resume` commands
 * both call it, in the caller's transaction, so a write that is refused or fails leaves nothing and its entry on the server's trail
 * commits with it or not at all.
 *
 * It refuses, before it writes, a module the build does not carry, a stop with no reason, and a stop that takes down a module
 * the product cannot do without (`entitlement: 'always'`, chat) unless the caller says it is meant. It answers what else stops with
 * the module because it requires it, which is the stored set closed over `requires` and nothing the administrator named twice.
 * A write that says what the table already says changes nothing and records nothing, so a command run twice is the same as once.
 */
import type { Transaction } from '@purlay/db';
import { SUSPENSION_REASON_MAX } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { effectiveModules } from '../../platform/module-kit/entitlement';
import { readSuspended } from '../../platform/suspended-modules';
import { serializeServerAdministrators } from '../administration/changes';
import { recordServerAudit } from '../audit/server-audit';
import type { EntitlementCatalogue } from '../entitlements/apply';

export interface SuspensionChange {
  readonly module: string;
  readonly state: 'suspended' | 'running';
  /** The operator's words; required to stop a module, and ignored when one is let run again. */
  readonly reason?: string | undefined;
  /** Says that taking down a module the product cannot do without is meant. */
  readonly force?: boolean | undefined;
}

/** Who wrote: a label for the row (`operator`, `cli`) and the administrator, when there is one. */
export interface SuspensionActor {
  readonly source: string;
  readonly userId: string | null;
}

export interface SuspensionResult {
  readonly changed: boolean;
  /** Every module that is out of service because of this one, and not itself, in the build's order. */
  readonly alsoAffected: readonly string[];
  /** The stopped modules as the table holds them once this write is in, for the node to believe at once after the commit. */
  readonly suspended: ReadonlySet<string>;
}

const refused = (field: string, reason: string): AppError =>
  new AppError({
    code: 'VALIDATION_FAILED',
    message: 'The stop is not valid.',
    details: { fields: { [field]: reason } },
  });

/** The modules of the build that are out of service when exactly `stopped` are stopped: the closure over `requires`. */
const outOfService = (
  catalogue: EntitlementCatalogue,
  stopped: ReadonlySet<string>,
  now: Date,
): ReadonlySet<string> => {
  const serving = effectiveModules({
    running: catalogue.carried,
    rows: [],
    mode: 'open',
    now,
    suspended: stopped,
  });
  return new Set(catalogue.carried.map(({ id }) => id).filter((id) => !serving.has(id)));
};

export const applySuspension = async (
  tx: Transaction,
  clock: Clock,
  catalogue: EntitlementCatalogue,
  actor: SuspensionActor,
  change: SuspensionChange,
): Promise<SuspensionResult> => {
  const now = clock.now();
  const carried = catalogue.carried.find(({ id }) => id === change.module);
  if (carried === undefined) throw refused('module', 'Is not a module this server carries.');
  const stopping = change.state === 'suspended';
  const reason = change.reason?.trim() ?? '';
  if (stopping && (reason.length === 0 || reason.length > SUSPENSION_REASON_MAX))
    throw refused(
      'reason',
      `Is needed to stop a module: 1 to ${String(SUSPENSION_REASON_MAX)} characters.`,
    );

  // One writer of the stops at a time, whoever it is: the console already holds this lock as the administrator, the command takes it here.
  await serializeServerAdministrators(tx);
  const before = await readSuspended(tx);
  const after = new Set(before);
  if (stopping) after.add(change.module);
  else after.delete(change.module);
  const outBefore = outOfService(catalogue, before, now);
  const outAfter = outOfService(catalogue, after, now);

  // Taking the product down is the one stop that asks twice: chat, or whatever would take chat with it.
  const newlyOut = [...outAfter].filter((id) => !outBefore.has(id));
  const critical = catalogue.carried.filter(
    ({ id, entitlement }) => entitlement === 'always' && newlyOut.includes(id),
  );
  if (stopping && critical.length > 0 && change.force !== true)
    throw refused(
      'force',
      `Stopping ${change.module} takes ${critical.map(({ id }) => id).join(', ')} down for every workspace. Say force: true to mean it.`,
    );

  let changed: boolean;
  if (stopping) {
    const written = await tx
      .insertInto('suspended_modules')
      .values({
        module: change.module,
        reason,
        source: actor.source,
        suspended_by: actor.userId,
        suspended_at: now,
      })
      .onConflict((conflict) => conflict.column('module').doNothing())
      .returning('module')
      .executeTakeFirst();
    changed = written !== undefined;
  } else {
    const removed = await tx
      .deleteFrom('suspended_modules')
      .where('module', '=', change.module)
      .returning('module')
      .executeTakeFirst();
    changed = removed !== undefined;
  }
  if (changed)
    await recordServerAudit(tx, clock, {
      actorUserId: actor.userId,
      action: stopping ? 'server.module_suspended' : 'server.module_resumed',
      targetModule: change.module,
      ...(stopping ? { note: reason } : {}),
    });
  const moved = stopping ? newlyOut : [...outBefore].filter((id) => !outAfter.has(id));
  return {
    changed,
    alsoAffected: moved.filter((id) => id !== change.module),
    suspended: await readSuspended(tx),
  };
};
