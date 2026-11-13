/** Explicit physical mapping of the pinned native SCIM schema; no second resource authority. */
import { scim, type SCIMOptions } from '@better-auth/scim';
import type { BetterAuthPlugin } from 'better-auth';

export const directoryScimSchema = (options: SCIMOptions): BetterAuthPlugin => {
  const plugin = scim(options);
  return {
    ...plugin,
    schema: {
      scimConnectionBinding: {
        ...plugin.schema.scimConnectionBinding,
        modelName: 'workspace_directory_scim_bindings',
        fields: {
          connectionId: {
            ...plugin.schema.scimConnectionBinding.fields.connectionId,
            fieldName: 'connection_id',
          },
          connectionKey: {
            ...plugin.schema.scimConnectionBinding.fields.connectionKey,
            fieldName: 'connection_key',
          },
          provisioningDomainId: {
            ...plugin.schema.scimConnectionBinding.fields.provisioningDomainId,
            fieldName: 'provisioning_domain_id',
          },
          createdAt: {
            ...plugin.schema.scimConnectionBinding.fields.createdAt,
            fieldName: 'created_at',
          },
          decommissionedAt: {
            ...plugin.schema.scimConnectionBinding.fields.decommissionedAt,
            fieldName: 'decommissioned_at',
          },
          decommissionStatus: {
            ...plugin.schema.scimConnectionBinding.fields.decommissionStatus,
            fieldName: 'decommission_status',
          },
          decommissionCursorUserId: {
            ...plugin.schema.scimConnectionBinding.fields.decommissionCursorUserId,
            fieldName: 'decommission_cursor_user_id',
          },
          decommissionReconciledUserCount: {
            ...plugin.schema.scimConnectionBinding.fields.decommissionReconciledUserCount,
            fieldName: 'decommission_reconciled_user_count',
          },
          decommissionBatchCount: {
            ...plugin.schema.scimConnectionBinding.fields.decommissionBatchCount,
            fieldName: 'decommission_batch_count',
          },
          decommissionRevision: {
            ...plugin.schema.scimConnectionBinding.fields.decommissionRevision,
            fieldName: 'decommission_revision',
          },
          decommissionCompletedAt: {
            ...plugin.schema.scimConnectionBinding.fields.decommissionCompletedAt,
            fieldName: 'decommission_completed_at',
          },
          decommissionLeaseId: {
            ...plugin.schema.scimConnectionBinding.fields.decommissionLeaseId,
            fieldName: 'decommission_lease_id',
          },
          decommissionLeaseExpiresAt: {
            ...plugin.schema.scimConnectionBinding.fields.decommissionLeaseExpiresAt,
            fieldName: 'decommission_lease_expires_at',
          },
        },
      },
      scimIdentityTombstone: {
        ...plugin.schema.scimIdentityTombstone,
        modelName: 'workspace_directory_scim_tombstones',
        fields: {
          connectionId: {
            ...plugin.schema.scimIdentityTombstone.fields.connectionId,
            fieldName: 'connection_id',
          },
          provisioningDomainId: {
            ...plugin.schema.scimIdentityTombstone.fields.provisioningDomainId,
            fieldName: 'provisioning_domain_id',
          },
          externalId: {
            ...plugin.schema.scimIdentityTombstone.fields.externalId,
            fieldName: 'external_id',
          },
          externalIdKey: {
            ...plugin.schema.scimIdentityTombstone.fields.externalIdKey,
            fieldName: 'external_id_key',
          },
          userId: { ...plugin.schema.scimIdentityTombstone.fields.userId, fieldName: 'user_id' },
          profile: { ...plugin.schema.scimIdentityTombstone.fields.profile, fieldName: 'profile' },
          deletedAt: {
            ...plugin.schema.scimIdentityTombstone.fields.deletedAt,
            fieldName: 'deleted_at',
          },
        },
      },
      scimSubject: {
        ...plugin.schema.scimSubject,
        modelName: 'workspace_directory_scim_subjects',
        fields: {
          userId: { ...plugin.schema.scimSubject.fields.userId, fieldName: 'user_id' },
          profileSourceId: {
            ...plugin.schema.scimSubject.fields.profileSourceId,
            fieldName: 'profile_source_id',
          },
          revision: { ...plugin.schema.scimSubject.fields.revision, fieldName: 'revision' },
          createdAt: { ...plugin.schema.scimSubject.fields.createdAt, fieldName: 'created_at' },
          updatedAt: { ...plugin.schema.scimSubject.fields.updatedAt, fieldName: 'updated_at' },
        },
      },
      scimUser: {
        ...plugin.schema.scimUser,
        modelName: 'workspace_directory_scim_users',
        fields: {
          connectionId: {
            ...plugin.schema.scimUser.fields.connectionId,
            fieldName: 'connection_id',
          },
          provisioningDomainId: {
            ...plugin.schema.scimUser.fields.provisioningDomainId,
            fieldName: 'provisioning_domain_id',
          },
          userId: { ...plugin.schema.scimUser.fields.userId, fieldName: 'user_id' },
          connectionUserKey: {
            ...plugin.schema.scimUser.fields.connectionUserKey,
            fieldName: 'connection_user_key',
          },
          userName: { ...plugin.schema.scimUser.fields.userName, fieldName: 'user_name' },
          userNameKey: { ...plugin.schema.scimUser.fields.userNameKey, fieldName: 'user_name_key' },
          primaryEmail: {
            ...plugin.schema.scimUser.fields.primaryEmail,
            fieldName: 'primary_email',
          },
          workEmailValueIndex: {
            ...plugin.schema.scimUser.fields.workEmailValueIndex,
            fieldName: 'work_email_value_index',
          },
          emailValueIndex: {
            ...plugin.schema.scimUser.fields.emailValueIndex,
            fieldName: 'email_value_index',
          },
          displayName: { ...plugin.schema.scimUser.fields.displayName, fieldName: 'display_name' },
          formattedName: {
            ...plugin.schema.scimUser.fields.formattedName,
            fieldName: 'formatted_name',
          },
          givenName: { ...plugin.schema.scimUser.fields.givenName, fieldName: 'given_name' },
          familyName: { ...plugin.schema.scimUser.fields.familyName, fieldName: 'family_name' },
          serializedEmails: {
            ...plugin.schema.scimUser.fields.serializedEmails,
            fieldName: 'serialized_emails',
          },
          serializedAttributes: {
            ...plugin.schema.scimUser.fields.serializedAttributes,
            fieldName: 'serialized_attributes',
          },
          externalId: { ...plugin.schema.scimUser.fields.externalId, fieldName: 'external_id' },
          externalIdKey: {
            ...plugin.schema.scimUser.fields.externalIdKey,
            fieldName: 'external_id_key',
          },
          active: { ...plugin.schema.scimUser.fields.active, fieldName: 'active' },
          orderKey: { ...plugin.schema.scimUser.fields.orderKey, fieldName: 'order_key' },
          createdAt: { ...plugin.schema.scimUser.fields.createdAt, fieldName: 'created_at' },
          updatedAt: { ...plugin.schema.scimUser.fields.updatedAt, fieldName: 'updated_at' },
        },
      },
      scimProjectionGrant: {
        ...plugin.schema.scimProjectionGrant,
        modelName: 'workspace_directory_scim_grants',
        fields: {
          connectionId: {
            ...plugin.schema.scimProjectionGrant.fields.connectionId,
            fieldName: 'connection_id',
          },
          provisioningDomainId: {
            ...plugin.schema.scimProjectionGrant.fields.provisioningDomainId,
            fieldName: 'provisioning_domain_id',
          },
          scimUserId: {
            ...plugin.schema.scimProjectionGrant.fields.scimUserId,
            fieldName: 'scim_user_id',
          },
          userId: { ...plugin.schema.scimProjectionGrant.fields.userId, fieldName: 'user_id' },
          sourceKind: {
            ...plugin.schema.scimProjectionGrant.fields.sourceKind,
            fieldName: 'source_kind',
          },
          sourceId: {
            ...plugin.schema.scimProjectionGrant.fields.sourceId,
            fieldName: 'source_id',
          },
          sourceValue: {
            ...plugin.schema.scimProjectionGrant.fields.sourceValue,
            fieldName: 'source_value',
          },
          role: { ...plugin.schema.scimProjectionGrant.fields.role, fieldName: 'role' },
          grantKey: {
            ...plugin.schema.scimProjectionGrant.fields.grantKey,
            fieldName: 'grant_key',
          },
          createdAt: {
            ...plugin.schema.scimProjectionGrant.fields.createdAt,
            fieldName: 'created_at',
          },
          updatedAt: {
            ...plugin.schema.scimProjectionGrant.fields.updatedAt,
            fieldName: 'updated_at',
          },
        },
      },
      scimGroup: {
        ...plugin.schema.scimGroup,
        modelName: 'workspace_directory_scim_groups',
        fields: {
          connectionId: {
            ...plugin.schema.scimGroup.fields.connectionId,
            fieldName: 'connection_id',
          },
          provisioningDomainId: {
            ...plugin.schema.scimGroup.fields.provisioningDomainId,
            fieldName: 'provisioning_domain_id',
          },
          revision: { ...plugin.schema.scimGroup.fields.revision, fieldName: 'revision' },
          displayName: { ...plugin.schema.scimGroup.fields.displayName, fieldName: 'display_name' },
          displayNameKey: {
            ...plugin.schema.scimGroup.fields.displayNameKey,
            fieldName: 'display_name_key',
          },
          externalId: { ...plugin.schema.scimGroup.fields.externalId, fieldName: 'external_id' },
          externalIdKey: {
            ...plugin.schema.scimGroup.fields.externalIdKey,
            fieldName: 'external_id_key',
          },
          orderKey: { ...plugin.schema.scimGroup.fields.orderKey, fieldName: 'order_key' },
          createdAt: { ...plugin.schema.scimGroup.fields.createdAt, fieldName: 'created_at' },
          updatedAt: { ...plugin.schema.scimGroup.fields.updatedAt, fieldName: 'updated_at' },
        },
      },
      scimGroupMember: {
        ...plugin.schema.scimGroupMember,
        modelName: 'workspace_directory_scim_group_members',
        fields: {
          connectionId: {
            ...plugin.schema.scimGroupMember.fields.connectionId,
            fieldName: 'connection_id',
          },
          groupId: { ...plugin.schema.scimGroupMember.fields.groupId, fieldName: 'group_id' },
          scimUserId: {
            ...plugin.schema.scimGroupMember.fields.scimUserId,
            fieldName: 'scim_user_id',
          },
          membershipKey: {
            ...plugin.schema.scimGroupMember.fields.membershipKey,
            fieldName: 'membership_key',
          },
          createdAt: { ...plugin.schema.scimGroupMember.fields.createdAt, fieldName: 'created_at' },
        },
      },
    },
  };
};
