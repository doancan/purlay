/** A module's current live subscription authority, enforced before any payload is written. */
import type { ServerFrame } from '@purlay/types';

/** Hidden content, current authority denial and a changed active policy have different cache/draft effects. */
export type ChannelDeliveryVerdict = boolean | 'revoked' | 'resync';

export interface ChannelDeliveryScope {
  /** Stable for the same server-authorized grant; an unchanged resubscription keeps pending frames. */
  readonly key: string;
  readonly expiresAt: number | null;
  /** A missed membership change may have replaced this deadline; a positive check only requests reauthorization. */
  readonly expiry?: {
    readonly workspaceId: string;
    readonly recheck: (signal: AbortSignal) => Promise<boolean>;
  };
  /** False drops an out-of-scope frame; failure resynchronizes instead of silently losing a change. */
  readonly accepts: (frame: ServerFrame, signal: AbortSignal) => Promise<ChannelDeliveryVerdict>;
}

/** Optional on older transports; guarded channel subscriptions are refused when this gate is absent. */
export interface ChannelDeliveryGate {
  readonly restrictChannel?: (
    socketId: string,
    channelId: string,
    scope: ChannelDeliveryScope,
  ) => void;
  readonly releaseChannels?: (socketId: string, channelIds: readonly string[]) => void;
}
