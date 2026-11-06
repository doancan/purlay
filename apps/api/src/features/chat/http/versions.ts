/**
 * A message's earlier versions through HTTP (#82, D-135): read by anybody who can read the message,
 * and one removed by its author. Validate, call one service, answer.
 */
import { Elysia, type AnyElysia } from 'elysia';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import { OlderPageQuery, type MessageVersionPage } from '@purlay/types';
import { atomicallyOn } from '../../../platform/transactions';
import { messageVersions, removeVersion } from '../messages/versions';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishMessageVersionsUpdated,
} from '../../../platform/events';
import type { ChannelDependencies, ChannelWriteDependencies } from '../../../ingress/http/channels';
import { requireSession } from '../../../ingress/http/session';
import { queryOf, validated } from '../../../ingress/http/validate';

/** `GET /api/messages/:messageId/versions` */
const listVersions = async (
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

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const versionRoutes = (context: ModuleRouteDependencies): AnyElysia =>
  new Elysia()
    .get(
      '/api/messages/:messageId/versions',
      async ({ request, params }) => await listVersions(context, request, params.messageId),
    )
    .delete('/api/messages/:messageId/versions/:versionId', async ({ request, params, set }) => {
      await deleteVersion(context, request, params.messageId, params.versionId);
      set.status = 204;
      return null;
    });
