/** Directory administration retains native owner/admin authority and exact revision fences. */
import type {
  WorkspaceProvisioningActor,
  WorkspaceProvisioningDependencies,
} from '../provisioning/authority';
import { AppError } from '../../../platform/errors';
import type { EventBus } from '../../../platform/events';

export type WorkspaceDirectoryActor = WorkspaceProvisioningActor;
export interface WorkspaceDirectoryDependencies extends WorkspaceProvisioningDependencies {
  readonly baseUrl: string;
  readonly bus: EventBus;
}
export const directoryMissing = (): AppError =>
  new AppError({ code: 'WORKSPACE_DIRECTORY_NOT_FOUND', message: 'Directory not found.' });
export const directoryChanged = (): AppError =>
  new AppError({
    code: 'WORKSPACE_DIRECTORY_CHANGED',
    message: 'Directory configuration changed. Reload before trying again.',
  });
const directoryNotReady = (): AppError =>
  new AppError({
    code: 'WORKSPACE_DIRECTORY_NOT_READY',
    message: 'Directory provisioning is not ready on every reader.',
  });
export const directoryInvalid = (field: string, message: string): AppError =>
  new AppError({
    code: 'VALIDATION_FAILED',
    message: 'The request did not match the contract.',
    details: { fields: { [field]: message } },
  });
export const requireDirectoryReady = async (
  readersReady: () => Promise<boolean>,
): Promise<void> => {
  let ready = false;
  try {
    ready = await readersReady();
  } catch {
    throw directoryNotReady();
  }
  if (!ready) throw directoryNotReady();
};
