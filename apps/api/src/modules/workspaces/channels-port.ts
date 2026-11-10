/**
 * What the workspace code needs from the channels of a workspace without naming them (D-250): the core defines
 * it, and chat — whose channels they are — implements it where the application is put together. With chat
 * absent there are no channels, and `noWorkspaceChannels` says so.
 */
import type { Executor, RawBuilder, Transaction } from '@purlay/db';
import type { WorkspaceContext } from '../../platform/tenancy';
import type { Clock } from '../../platform/clock';

/** Admission is implemented by the module that owns the granted conversations. */
export interface WorkspaceGuestChannels {
  readonly moduleId: string;
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
  ): Promise<void>;
}

export interface WorkspaceChannels {
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
  leaveAll: () => Promise.resolve([]),
  keptLonger: () => Promise.resolve(0),
  idsIn: () => Promise.resolve([]),
};
