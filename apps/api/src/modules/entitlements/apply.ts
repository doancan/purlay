/**
 * The one writer of `workspace_modules` (D-289): the administration console and the edition file's command both call it, and a
 * billing system would too, as an actor of its own. Always called inside the caller's transaction, so a write that is refused
 * or fails leaves nothing, and its audit entry commits with it or not at all.
 *
 * What it refuses is said in the caller's words: a module the build does not carry, one no workspace is granted (chat, for
 * now), a workspace that is not there, an end that has passed, and a grant of a module whose requirement the workspace would
 * still lack (`MODULE_REQUIRES`).
 */
import type { Transaction } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import {
  effectiveModules,
  type EntitlementMode,
  type EntitlementCandidate,
  type EntitlementRow,
} from '../../platform/module-kit/entitlement';
import { recordServerAudit } from '../audit/server-audit';
import type { ServerAuditAction } from '../audit/server-audit';

/** What a write needs to know of the build: every module it carries, run or not, and the server's mode. */
export interface EntitlementCatalogue {
  readonly carried: readonly EntitlementCandidate[];
  readonly mode: EntitlementMode;
}

export interface EntitlementWrite {
  readonly workspaceId: string;
  readonly module: string;
  /** `inherit` removes the row: the server's mode decides again. */
  readonly state: 'on' | 'off' | 'inherit';
  /** Until when an `on` or `off` counts; left out, for good. */
  readonly validUntil?: Date;
}

/** Who wrote: a label for the row (`operator`, `file:editions.json`) and the administrator, when there is one. */
export interface EntitlementActor {
  readonly source: string;
  readonly userId: string | null;
}

export interface EntitlementChange {
  readonly workspaceId: string;
  readonly module: string;
  readonly state: EntitlementWrite['state'];
}

const refused = (field: string, reason: string): AppError =>
  new AppError({
    code: 'VALIDATION_FAILED',
    message: 'The grant is not valid.',
    details: { fields: { [field]: reason } },
  });

const ACTIONS: Readonly<Record<EntitlementWrite['state'], ServerAuditAction>> = {
  on: 'server.module_granted',
  off: 'server.module_withdrawn',
  inherit: 'server.module_reset',
};

const sameEnd = (existing: Date | null, wanted: Date | undefined): boolean =>
  (existing?.getTime() ?? null) === (wanted?.getTime() ?? null);

/**
 * Applies the writes in order and answers those that changed something. A write that says what the table already says changes
 * nothing and records nothing, so a command run twice, or a retried request, is the same as once.
 */
export const applyEntitlements = async (
  tx: Transaction,
  clock: Clock,
  catalogue: EntitlementCatalogue,
  actor: EntitlementActor,
  writes: readonly EntitlementWrite[],
): Promise<readonly EntitlementChange[]> => {
  const now = clock.now();
  for (const write of writes) {
    const carried = catalogue.carried.find(({ id }) => id === write.module);
    if (carried === undefined) throw refused('module', 'Is not a module this server carries.');
    if (carried.entitlement === 'always')
      throw refused('module', 'Is not a module a workspace is granted.');
    if (write.validUntil !== undefined) {
      if (write.state === 'inherit')
        throw refused('validUntil', 'Cannot end a row that is removed.');
      if (write.validUntil.getTime() <= now.getTime())
        throw refused('validUntil', 'Must be in the future.');
    }
  }
  const workspaceIds = [...new Set(writes.map(({ workspaceId }) => workspaceId))].sort();
  if (workspaceIds.length === 0) return [];
  // Locked in one order, so two writers of one workspace take turns and two of several cannot wait on each other.
  const found = await tx
    .selectFrom('workspaces')
    .select('id')
    .where('id', 'in', workspaceIds)
    .where('deleted_at', 'is', null)
    .orderBy('id')
    .forUpdate()
    .execute();
  if (found.length !== workspaceIds.length)
    throw new AppError({ code: 'WORKSPACE_NOT_FOUND', message: 'No such workspace.' });

  const existing = await tx
    .selectFrom('workspace_modules')
    .select(['workspace_id', 'module', 'state', 'valid_until'])
    .where('workspace_id', 'in', workspaceIds)
    .execute();
  const rows = new Map(existing.map((row) => [`${row.workspace_id}/${row.module}`, row]));

  // Plan first and write after: what the table would hold is judged before it is touched, so a refusal leaves nothing even where
  // the caller's transaction is not the one to undo it.
  const planned: EntitlementWrite[] = [];
  for (const write of writes) {
    const key = `${write.workspaceId}/${write.module}`;
    const row = rows.get(key);
    if (write.state === 'inherit') {
      if (row === undefined) continue;
      rows.delete(key);
    } else {
      if (
        row?.state === write.state &&
        sameEnd(row.valid_until === null ? null : new Date(row.valid_until), write.validUntil)
      )
        continue;
      rows.set(key, {
        workspace_id: write.workspaceId,
        module: write.module,
        state: write.state,
        valid_until: write.validUntil ?? null,
      });
    }
    planned.push(write);
  }

  // A module is not granted to a workspace that lacks one it requires, whichever order the writes came in.
  for (const write of planned.filter(({ state }) => state === 'on')) {
    const granted: EntitlementRow[] = [...rows.values()]
      .filter((row) => row.workspace_id === write.workspaceId)
      .map((row) => ({
        module: row.module,
        state: row.state === 'on' ? 'on' : 'off',
        validUntil: row.valid_until === null ? null : new Date(row.valid_until),
      }));
    const effective = effectiveModules({
      running: catalogue.carried,
      rows: granted,
      mode: catalogue.mode,
      now,
    });
    if (!effective.has(write.module)) {
      const requires = catalogue.carried.find(({ id }) => id === write.module)?.requires ?? [];
      throw new AppError({
        code: 'MODULE_REQUIRES',
        message: `The module requires ${requires.filter((id) => !effective.has(id)).join(', ')}, which the workspace is not granted.`,
      });
    }
  }

  const changes: EntitlementChange[] = [];
  for (const write of planned) {
    if (write.state === 'inherit') {
      await tx
        .deleteFrom('workspace_modules')
        .where('workspace_id', '=', write.workspaceId)
        .where('module', '=', write.module)
        .execute();
    } else {
      const values = {
        state: write.state,
        valid_until: write.validUntil ?? null,
        source: actor.source,
        changed_by: actor.userId,
        changed_at: now,
      };
      await tx
        .insertInto('workspace_modules')
        .values({ workspace_id: write.workspaceId, module: write.module, ...values })
        .onConflict((conflict) => conflict.columns(['workspace_id', 'module']).doUpdateSet(values))
        .execute();
    }
    await recordServerAudit(tx, clock, {
      actorUserId: actor.userId,
      action: ACTIONS[write.state],
      targetWorkspaceId: write.workspaceId,
      targetModule: write.module,
    });
    changes.push({ workspaceId: write.workspaceId, module: write.module, state: write.state });
  }
  return changes;
};
