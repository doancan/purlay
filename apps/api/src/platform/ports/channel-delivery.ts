/** A module's narrower live subscription, enforced by the transport before any payload is written. */
import type { ServerFrame } from '@purlay/types';

export interface ChannelDeliveryScope {
  /** Stable for the same server-authorized grant; an unchanged resubscription keeps pending frames. */
  readonly key: string;
  readonly expiresAt: number | null;
  /** False drops an out-of-scope frame; failure resynchronizes instead of silently losing a change. */
  readonly accepts: (frame: ServerFrame, signal: AbortSignal) => Promise<boolean>;
}

/** Optional on older transports; a handler must refuse restricted admission when the gate is absent. */
export interface ChannelDeliveryGate {
  readonly restrictChannel?: (
    socketId: string,
    channelId: string,
    scope: ChannelDeliveryScope,
  ) => void;
  readonly releaseChannels?: (socketId: string, channelIds: readonly string[]) => void;
}
