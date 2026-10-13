/**
 * A channel's pins through HTTP (#485, D-130): pin, let go, and the list. A change tells everyone
 * watching the channel (`PINS_UPDATED`), after the commit, and only when it was one.
 */
import type { PinList } from '@purlay/types';
import { requireChannelById } from '../../platform/channels';
import { NO_LOG, publication, publishAfterCommit, publishPinsUpdated } from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { channelPins, pinMessage, unpinMessage, type PinChange } from '../../modules/pins/pins';
import type { ChannelDependencies, ChannelWriteDependencies } from './channels';
import { requireSession } from './session';

const told = async (
  { bus, clock, log = NO_LOG }: ChannelWriteDependencies,
  change: PinChange,
): Promise<void> => {
  if (!change.changed) return;
  await publishAfterCommit(log, [
    [publication('PINS_UPDATED', () => publishPinsUpdated(bus, clock, change.channelId))],
  ]);
};

/** `PUT /api/messages/:messageId/pin` — pinned for the channel; the same answer again. */
export const putPin = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  messageId: string,
): Promise<void> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const change = await atomicallyOn(database)(
    async (transaction) => await pinMessage(transaction, clock, userId, messageId),
  );
  await told(dependencies, change);
};

/** `DELETE /api/messages/:messageId/pin` — let go; letting go of nothing is the same 204. */
export const deletePin = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  messageId: string,
): Promise<void> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const change = await atomicallyOn(database)(
    async (transaction) => await unpinMessage(transaction, userId, messageId),
  );
  await told(dependencies, change);
};

/** `GET /api/channels/:channelId/pins` — newest pin first, bounded by `PINS_MAX`. */
export const listPins = async (
  { database, clock }: ChannelDependencies,
  request: Request,
  channelId: string,
): Promise<PinList> => {
  const { userId } = await requireSession(database, clock, request);
  const context = await requireChannelById(database, userId, channelId);
  return await channelPins(database, context);
};
