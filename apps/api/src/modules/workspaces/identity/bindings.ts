/** Own account links never expose external subjects or delete a newer binding with an older form. */
import { PAGE_LIMIT, type OlderPageQuery } from '@purlay/types';
import { type MyCompanyIdentityPage } from '@purlay/types/workspace-identity';
import { atomicallyOn } from '../../../platform/transactions';
import { recordAudit } from '../../audit/audit';
import { companyProviderId } from './catalogue';
import {
  identityChanged,
  lockCompanyIdentityActor,
  type CompanyIdentityActor,
  type CompanyIdentityDependencies,
} from './authority';

export const myCompanyIdentities = async (
  dependencies: CompanyIdentityDependencies,
  actor: CompanyIdentityActor,
  query: OlderPageQuery = {},
): Promise<MyCompanyIdentityPage> =>
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const context = await lockCompanyIdentityActor(transaction, dependencies, actor, false);
    const limit = query.limit ?? PAGE_LIMIT.default;
    let statement = transaction
      .selectFrom('workspace_identity_connections as connection')
      .innerJoin('workspace_identity_domains as domain', (join) =>
        join
          .onRef('domain.id', '=', 'connection.domain_id')
          .onRef('domain.workspace_id', '=', 'connection.workspace_id'),
      )
      .leftJoin('workspace_identity_bindings as binding', (join) =>
        join
          .onRef('binding.connection_id', '=', 'connection.id')
          .onRef('binding.workspace_id', '=', 'connection.workspace_id')
          .on('binding.user_id', '=', context.userId),
      )
      .select([
        'connection.id',
        'connection.revision',
        'connection.name',
        'connection.enabled',
        'connection.deleted_at',
        'connection.authentication_revision',
        'connection.tested_authentication_revision',
        'domain.verified_at',
        'domain.revoked_at',
        'binding.id as binding_id',
        'binding.created_at as linked_at',
      ])
      .where('connection.workspace_id', '=', context.workspaceId)
      .where((expression) =>
        expression.or([
          expression('connection.enabled', '=', true),
          expression('binding.id', 'is not', null),
        ]),
      )
      .orderBy('connection.id', 'desc');
    if (query.before !== undefined) statement = statement.where('connection.id', '<', query.before);
    const rows = await statement.limit(limit + 1).execute();
    const page = rows.slice(0, limit);
    return {
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      data: page.map((row) => ({
        connectionId: row.id,
        revision: row.revision,
        name: row.name,
        available:
          row.enabled &&
          row.deleted_at === null &&
          row.verified_at !== null &&
          row.revoked_at === null &&
          row.tested_authentication_revision !== null &&
          row.tested_authentication_revision === row.authentication_revision,
        bindingId: row.binding_id,
        linkedAt: row.linked_at === null ? null : new Date(row.linked_at).toISOString(),
      })),
    };
  });

export const unlinkCompanyIdentity = async (
  dependencies: CompanyIdentityDependencies,
  actor: CompanyIdentityActor,
  connectionId: string,
  bindingId: string,
): Promise<void> => {
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const context = await lockCompanyIdentityActor(transaction, dependencies, actor, false);
    const binding = await transaction
      .selectFrom('workspace_identity_bindings')
      .select('id')
      .where('workspace_id', '=', context.workspaceId)
      .where('connection_id', '=', connectionId)
      .where('user_id', '=', context.userId)
      .executeTakeFirst();
    if (binding === undefined) return;
    if (binding.id !== bindingId) throw identityChanged();
    await transaction
      .updateTable('workspace_identity_sessions')
      .set({ revoked_at: dependencies.clock.now() })
      .where('workspace_id', '=', context.workspaceId)
      .where('binding_reference', '=', binding.id)
      .where('revoked_at', 'is', null)
      .execute();
    await transaction
      .deleteFrom('accounts')
      .where('user_id', '=', context.userId)
      .where('provider_id', '=', companyProviderId(connectionId))
      .where('account_id', '=', binding.id)
      .execute();
    await transaction
      .deleteFrom('workspace_identity_bindings')
      .where('workspace_id', '=', context.workspaceId)
      .where('id', '=', binding.id)
      .where('user_id', '=', context.userId)
      .execute();
    await recordAudit(transaction, dependencies.clock, {
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: 'identity.unlinked',
      targetType: 'integration',
      targetId: connectionId,
    });
  });
};
