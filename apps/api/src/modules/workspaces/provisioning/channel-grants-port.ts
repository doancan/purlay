/** Core requests scoped role grants; chat owns their storage and independent visibility guard. */
import type { Transaction } from '@purlay/db';
import type { WorkspaceAccessGrantQuery } from '@purlay/types/workspace-provisioning';
import type { Clock } from '../../../platform/clock';
import type { WorkspaceContext } from '../../../platform/tenancy';
import type { WorkspaceProjectionScope } from './scope';

export interface WorkspaceGrantChannel {
  readonly id: string;
  readonly name: string;
  readonly type: 'public' | 'private';
}

/** Returned only after the current actor's exact non-DM channel visibility has been checked. */
export interface WorkspaceChannelGrantDescriptor {
  readonly id: string;
  readonly revision: string;
  readonly roleId: string;
  readonly sourceId: string | null;
  readonly groupId: string | null;
  readonly channel: WorkspaceGrantChannel;
  readonly createdAt: Date | string;
}

interface AssignWorkspaceChannelGrant {
  readonly roleId: string;
  readonly subject:
    | { readonly kind: 'source'; readonly sourceId: string }
    | { readonly kind: 'group'; readonly groupId: string };
  readonly channelId: string;
}

export interface WorkspaceChannelGrantsPort {
  descriptor(
    transaction: Transaction,
    context: WorkspaceContext,
    scope: WorkspaceProjectionScope,
    channelId: string,
  ): Promise<WorkspaceGrantChannel>;
  /** A bounded descending-id keyset; q searches role and subject labels before the limit. */
  list(
    transaction: Transaction,
    context: WorkspaceContext,
    scope: WorkspaceProjectionScope,
    query: WorkspaceAccessGrantQuery,
    take: number,
  ): Promise<readonly WorkspaceChannelGrantDescriptor[]>;
  find(
    transaction: Transaction,
    context: WorkspaceContext,
    scope: WorkspaceProjectionScope,
    grantId: string,
  ): Promise<WorkspaceChannelGrantDescriptor | undefined>;
  /** Idempotent for an identical role/subject/channel tuple; never creates channel membership. */
  assign(
    transaction: Transaction,
    clock: Clock,
    context: WorkspaceContext,
    scope: WorkspaceProjectionScope,
    input: AssignWorkspaceChannelGrant,
  ): Promise<WorkspaceChannelGrantDescriptor & { readonly created: boolean }>;
  revoke(
    transaction: Transaction,
    context: WorkspaceContext,
    scope: WorkspaceProjectionScope,
    grantId: string,
  ): Promise<void>;
}
