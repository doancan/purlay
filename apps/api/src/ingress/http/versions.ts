/**
 * A message's earlier versions through HTTP (#82, D-135): read by anybody who can read the message,
 * and one removed by its author. Validate, call one service, answer.
 */
import { OlderPageQuery, type MessageVersionPage } from '@purlay/types';
import { atomicallyOn } from '../../platform/transactions';
import { messageVersions, removeVersion } from '../../modules/messages/versions';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishMessageVersionsUpdated,
} from '../../platform/events';
import type { ChannelDependencies, ChannelWriteDependencies } from './channels';
import { requireSession } from './session';
import { queryOf, validated } from './validate';

/** `GET /api/messages/:messageId/versions` */
export const listVersions = async (
  { auth, database }: ChannelDependencies,
  request: Request,
  messageId: string,
): Promise<MessageVersionPage> => {
  const { userId } = await requireSession(auth, request);
  const query = validated(OlderPageQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await messageVersions(database, userId, messageId, query);
};

/** `DELETE /api/messages/:messageId/versions/:versionId` — and every open history is told. */
export const deleteVersion = async (
  { auth, database, clock, bus, log = NO_LOG }: ChannelWriteDependencies,
  request: Request,
  messageId: string,
  versionId: string,
): Promise<void> => {
  const { userId } = await requireSession(auth, request);
  const { channelId } = await atomicallyOn(database)(
    async (transaction) => await removeVersion(transaction, userId, messageId, versionId),
  );
  await publishAfterCommit(log, [
    [
      publication('MESSAGE_VERSIONS_UPDATED', () =>
        publishMessageVersionsUpdated(bus, clock, channelId, messageId),
      ),
    ],
  ]);
};
