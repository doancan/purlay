/**
 * A message's earlier versions through HTTP (#82, D-135): read by anybody who can read the message,
 * and one removed by its author. Validate, call one service, answer.
 */
import { OlderPageQuery, type MessageVersionPage } from '@purlay/types';
import { atomicallyOn } from '../../platform/transactions';
import { messageVersions, removeVersion } from '../../modules/messages/versions';
import type { ChannelDependencies } from './channels';
import { requireSession } from './session';
import { queryOf, validated } from './validate';

/** `GET /api/messages/:messageId/versions` */
export const listVersions = async (
  { database, clock }: ChannelDependencies,
  request: Request,
  messageId: string,
): Promise<MessageVersionPage> => {
  const { userId } = await requireSession(database, clock, request);
  const query = validated(OlderPageQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await messageVersions(database, userId, messageId, query);
};

/** `DELETE /api/messages/:messageId/versions/:versionId` */
export const deleteVersion = async (
  { database, clock }: ChannelDependencies,
  request: Request,
  messageId: string,
  versionId: string,
): Promise<void> => {
  const { userId } = await requireSession(database, clock, request);
  await atomicallyOn(database)(async (transaction) => {
    await removeVersion(transaction, userId, messageId, versionId);
  });
};
