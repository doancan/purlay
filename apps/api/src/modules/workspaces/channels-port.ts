/**
 * What the workspace code needs from the channels of a workspace without naming them (D-250): the core defines
 * it, and chat — whose channels they are — implements it where the application is put together. With chat
 * absent there are no channels, and `noWorkspaceChannels` says so.
 */
import type { ChannelAccessAction } from '@purlay/types';
import type { Executor, RawBuilder, Transaction } from '@purlay/db';
import type { WorkspaceContext } from '../../platform/tenancy';
import type { Clock } from '../../platform/clock';
import type { WorkspaceProjectionScope } from './provisioning/scope';
import type { WorkspaceChannelGrantsPort } from './provisioning/channel-grants-port';

/** Chat projects its own native membership rows without core naming a chat table. */
interface WorkspaceAccessChannels {
  aggregateCapabilities(
    executor: Executor,
    userId: string,
    workspaceIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly ChannelAccessAction[]>>;
  readonly grants?: WorkspaceChannelGrantsPort;
  project(
    executor: Transaction,
    clock: Clock,
    scope: WorkspaceProjectionScope,
    userIds: readonly string[],
  ): Promise<readonly string[]>;
  countFor(executor: Executor, workspaceId: string, userId: string): Promise<number>;
  roleUsers(executor: Executor, workspaceId: string, roleId: string): Promise<readonly string[]>;
}

/** Admission is implemented by the module that owns the granted conversations. */
export interface WorkspaceGuestChannels {
  readonly moduleId: string;
  /** Prepare ordered channel locks before core takes the workspace mutex; apply rechecks the captured scope. */
  prepareEdit(
    executor: Transaction,
    context: WorkspaceContext,
    userId: string,
    channelIds: readonly string[] | undefined,
  ): Promise<{
    apply(
      at: Date,
      resetHistory: boolean,
    ): Promise<{
      readonly visibleIds: readonly string[];
      readonly hiddenCount: number;
      readonly previousIds: readonly string[];
      readonly removedIds: readonly string[];
      readonly addedCount: number;
      readonly changed: boolean;
    }>;
  }>;
  /** Scope for one administrator page: only visible identities, and a count for everything else. */
  scopes(
    executor: Executor,
    context: WorkspaceContext,
    userIds: readonly string[],
  ): Promise<
    ReadonlyMap<
      string,
      {
        readonly visibleIds: readonly string[];
        readonly hiddenCount: number;
      }
    >
  >;
  /** A guest's directory contains only active people in their explicitly shared conversations. */
  people(
    executor: Executor,
    context: WorkspaceContext,
    personId: RawBuilder<string>,
  ): RawBuilder<boolean>;
  /** Lock selected channels before the workspace mutex, then recheck administrator visibility. */
  prepare(
    executor: Transaction,
    context: WorkspaceContext,
    channelIds: readonly string[],
  ): Promise<void>;
  /** Grant only a restricted member, under the current administrator's authority, in the same transaction. */
  grant(
    executor: Transaction,
    clock: Clock,
    context: WorkspaceContext,
    userId: string,
    channelIds: readonly string[],
    newAdmission?: boolean,
  ): Promise<void>;
}

export interface WorkspaceChannels {
  readonly access?: WorkspaceAccessChannels;
  readonly guests?: WorkspaceGuestChannels;
  /**
   * Takes the person out of every channel of the workspace and answers the channels they could see, read
   * by the one visibility rule before it stops being theirs. Inside the caller's transaction, before the
   * caller takes their membership.
   */
  leaveAll(executor: Executor, workspaceId: string, userId: string): Promise<readonly string[]>;
  /**
   * How many of the workspace's channels keep longer than this window (D-225): forever, or a floor past it,
   * archived and private ones included. A workspace that keeps everything has none.
   */
  keptLonger(
    executor: Executor,
    context: WorkspaceContext,
    retentionDays: number | null,
  ): Promise<number>;
  /** Every channel of the workspace: who is told it went, or came back, after the commit. */
  idsIn(executor: Executor, workspaceId: string): Promise<readonly string[]>;
}

/** The channels of a workspace where there is no chat: none. */
export const noWorkspaceChannels: WorkspaceChannels = {
  access: {
    aggregateCapabilities: () => Promise.resolve(new Map()),
    project: () => Promise.resolve([]),
    countFor: () => Promise.resolve(0),
    roleUsers: () => Promise.resolve([]),
  },
  leaveAll: () => Promise.resolve([]),
  keptLonger: () => Promise.resolve(0),
  idsIn: () => Promise.resolve([]),
};

// The channel implementation consumes only these transaction-bound port capabilities.
export {
  lockWorkspaceProjectionScope,
  requireWorkspaceProjectionScope,
  noteWorkspaceChannelRevocation,
} from './provisioning/scope';
export type { WorkspaceProjectionScope } from './provisioning/scope';
export type {
  WorkspaceChannelGrantsPort,
  WorkspaceChannelGrantDescriptor,
  WorkspaceGrantChannel,
} from './provisioning/channel-grants-port';
