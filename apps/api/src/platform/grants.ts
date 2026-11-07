/**
 * Reading a workspace's grants (`workspace_modules`, D-289) as the rows `effectiveModules` takes: one subselect, put in the
 * statement that already finds the workspace, so the grants are of the snapshot the membership is and no node holds them stale.
 * The two statements that need them (the membership guard and the person's list of workspaces) share it.
 */
import { sql } from '@purlay/db';
import type { EntitlementRow } from './module-kit/entitlement';

interface RawGrant {
  readonly module: string;
  readonly state: string;
  readonly valid_until: string | null;
}

/**
 * The columns that read the grants of the workspace a statement has joined as `workspaces`, and the database's clock they are
 * judged by, so that every node judges the end of a grant by the same one.
 */
export const grantColumns = [
  sql<
    readonly RawGrant[]
  >`(select coalesce(json_agg(g), '[]'::json) from (select m.module, m.state, m.valid_until from workspace_modules m where m.workspace_id = workspaces.id) g)`.as(
    'grants',
  ),
  sql<Date>`now()`.as('read_at'),
] as const;

export const asGrants = (raw: readonly RawGrant[]): EntitlementRow[] =>
  raw.map((grant) => ({
    module: grant.module,
    // A state this code does not know is a refusal, never a grant.
    state: grant.state === 'on' ? 'on' : 'off',
    validUntil: grant.valid_until === null ? null : new Date(grant.valid_until),
  }));
