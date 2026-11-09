// How long data is kept, and its leaving: retention, storage, exports, erasure and workspace deletion.
import {
  ChannelRetention,
  RetentionSetting,
  StorageUsage,
  WorkspaceDeletion,
  WorkspaceExport,
  type ChannelRetentionFloor,
} from '@purlay/types';
import { Type } from '@sinclair/typebox';
import type { Http } from '../http';
import { at, options } from './request';

const WorkspaceExports = Type.Array(WorkspaceExport);

export interface RetentionApi {
  /** How long the workspace keeps its history; an owner's (D-139 §4). */
  readonly retention: (workspaceId: string, signal?: AbortSignal) => Promise<RetentionSetting>;
  /** An owner's: the workspace's storage used and its quota (D-173). */
  readonly storage: (workspaceId: string, signal?: AbortSignal) => Promise<StorageUsage>;
  readonly setRetention: (
    workspaceId: string,
    retentionDays: number | null,
  ) => Promise<RetentionSetting>;
  /** How long a channel keeps its history beside its workspace's window; an owner's (D-225). */
  readonly channelRetention: (channelId: string, signal?: AbortSignal) => Promise<ChannelRetention>;
  readonly setChannelRetention: (
    channelId: string,
    keepsAtLeast: ChannelRetentionFloor,
  ) => Promise<ChannelRetention>;
  /** An owner's exports of the workspace, newest first; and asking for one, made in the background (D-140). */
  readonly exports: (workspaceId: string, signal?: AbortSignal) => Promise<WorkspaceExport[]>;
  readonly requestExport: (workspaceId: string) => Promise<WorkspaceExport>;
  /** An owner asks for the workspace to be deleted, typing its name (D-242). */
  readonly requestWorkspaceDeletion: (
    workspaceId: string,
    confirm: string,
  ) => Promise<WorkspaceDeletion>;
  /** Any owner takes a workspace's deletion back within its grace period (D-242). */
  readonly cancelWorkspaceDeletion: (workspaceId: string) => Promise<void>;
  /** The caller's own exports of their data, newest first; and asking for one (D-241). */
  readonly myExports: (signal?: AbortSignal) => Promise<WorkspaceExport[]>;
  readonly requestMyExport: () => Promise<WorkspaceExport>;
  /** Erases the caller's own account (D-139 §5); the answer clears the session cookie. */
  readonly eraseAccount: (confirm: string) => Promise<void>;
}

export const createRetentionApi = (http: Http): RetentionApi => ({
  retention: (workspaceId, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/retention`,
      RetentionSetting,
      options({}, signal),
    ),
  storage: (workspaceId, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/storage`,
      StorageUsage,
      options({}, signal),
    ),
  setRetention: (workspaceId, retentionDays) =>
    http.request(
      'PUT',
      `/api/workspaces/${at(workspaceId)}/retention`,
      RetentionSetting,
      options({ body: { retentionDays } }),
    ),
  channelRetention: (channelId, signal) =>
    http.request(
      'GET',
      `/api/channels/${at(channelId)}/retention`,
      ChannelRetention,
      options({}, signal),
    ),
  setChannelRetention: (channelId, keepsAtLeast) =>
    http.request(
      'PUT',
      `/api/channels/${at(channelId)}/retention`,
      ChannelRetention,
      options({ body: { keepsAtLeast } }),
    ),
  exports: (workspaceId, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/exports`,
      WorkspaceExports,
      options({}, signal),
    ),
  requestExport: (workspaceId) =>
    http.request('POST', `/api/workspaces/${at(workspaceId)}/exports`, WorkspaceExport, options()),
  requestWorkspaceDeletion: (workspaceId, confirm) =>
    http.request(
      'POST',
      `/api/workspaces/${at(workspaceId)}/deletion`,
      WorkspaceDeletion,
      options({ body: { confirm } }),
    ),
  cancelWorkspaceDeletion: (workspaceId) =>
    http.send('DELETE', `/api/workspaces/${at(workspaceId)}/deletion`, options()),
  myExports: (signal) =>
    http.request('GET', '/api/me/exports', WorkspaceExports, options({}, signal)),
  requestMyExport: () => http.request('POST', '/api/me/exports', WorkspaceExport, options()),
  eraseAccount: (confirm) => http.send('POST', '/api/me/erase', options({ body: { confirm } })),
});
