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

/** Origin captured from native session resolution, never from a client frame. */
export interface CompanyDeliveryIdentity {
  readonly sessionId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export type CompanyFrameProjector = (
  identity: CompanyDeliveryIdentity,
  frame: ServerFrame,
  signal: AbortSignal,
) => Promise<ServerFrame | undefined>;

/** The final native source check never changes a workspace's proof or activity. */
export type WorkspaceFrameProjector = (
  identity: {
    readonly sessionId: string;
    readonly userId: string;
    readonly companyWorkspaceId?: string;
  },
  subscribedChannelIds: readonly string[],
  frame: ServerFrame,
  signal: AbortSignal,
  channelScope?: ChannelDeliveryScope,
) => Promise<
  | { readonly frame: ServerFrame | undefined }
  | { readonly restart: ServerFrame }
  | {
      readonly workspaceId: string;
      readonly channelIds: readonly string[];
      readonly changed?: true;
    }
>;
