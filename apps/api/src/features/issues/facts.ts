/**
 * What issues does when the core tells it something (`MODULES.md` §4, D-355): a person who stopped being a member of a workspace is
 * taken off its open issues, since an issue assigned to somebody who can no longer open it is stuck and nobody is told. A finished
 * issue keeps its assignee, as the record of who did it.
 *
 * Delivered at least once and late (D-288): the person's membership is read now, and one who may be given an issue again (they
 * came back) keeps what they hold; a second delivery finds nothing assigned and changes nothing.
 */
import { CORE_MEMBER_LEFT } from '@purlay/types';
import { recordAudit } from '../../modules/audit/audit';
import { fixedClock } from '../../platform/clock';
import { consumerOf, type FactConsumers } from '../../platform/fact-consumers';
import { isAssignable } from './issues';

export const issuesFactConsumers: FactConsumers = {
  ...consumerOf(CORE_MEMBER_LEFT, async (fact, transaction) => {
    const { workspaceId, payload, deliveredAt } = fact;
    if (await isAssignable(transaction, workspaceId, payload.userId)) return 'skipped';
    const unassigned = await transaction
      .updateTable('issues')
      .set({ assignee_id: null, updated_at: deliveredAt })
      .where('workspace_id', '=', workspaceId)
      .where('assignee_id', '=', payload.userId)
      .where('status', '=', 'open')
      .returning('id')
      .execute();
    // On the trail as a taking back by hand is, with nobody as the actor: the core's fact did it, not a person (D-254 §5).
    for (const { id } of unassigned) {
      await recordAudit(transaction, fixedClock(deliveredAt), {
        workspaceId,
        actorUserId: null,
        action: 'issue.assigned',
        targetType: 'issue',
        targetId: id,
        metadata: { from: payload.userId, to: '' },
      });
    }
    return 'done';
  }),
};
