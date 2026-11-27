/**
 * What the core tells the modules when people stop being members of a workspace (D-355): `core.member-left`, one for each person,
 * published in the transaction that deleted their membership, so the fact exists exactly when the departure does. Every path that
 * deletes a membership row is handed one and calls it with the people its delete returned: leaving, a removal, and a projection of
 * provisioned access that ends somebody's (SCIM, a group, a role, an offboarding).
 *
 * A fact refused for a full backlog or the workspace's rate ends the departure's transaction, so a person never leaves without the
 * modules being told: the request is answered `429` and tried again (D-288 §10).
 */
import type { Transaction } from '@purlay/db';
import { CORE_MEMBER_LEFT, type MemberLeftReason } from '@purlay/types';
import { publishFact } from '../../platform/outbox';
import type { SharedFactContext } from '../../platform/ports/fact-publisher';

export type MemberDepartures = (
  transaction: Transaction,
  workspaceId: string,
  userIds: readonly string[],
  reason: MemberLeftReason,
) => Promise<void>;

export const memberDeparturesOf =
  (shared: SharedFactContext): MemberDepartures =>
  async (transaction, workspaceId, userIds, reason) => {
    for (const userId of userIds) {
      await publishFact(
        transaction,
        { ...shared, workspaceId, producer: 'core' },
        CORE_MEMBER_LEFT,
        { userId, reason },
      );
    }
  };
