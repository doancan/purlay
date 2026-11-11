/** Restricted channel guests use the existing identity and membership authority (D-300). */
import { Type, type Static } from '@sinclair/typebox';
import { FromClient, GuestMembershipAccess, Timestamp, Uuid, User } from './models';
import { EMAIL_MAX } from './mailbox';
import { CreatedInvitation, OlderPageQuery, Page, SignInLocale } from './api';

/** A guest's channel scope is bounded at admission and every subsequent edit. */
export const GUEST_CHANNELS_MAX = 20;
export const GUEST_SEARCH_MAX = 100;

export const GuestChannelIds = Type.Array(Uuid, {
  minItems: 1,
  maxItems: GUEST_CHANNELS_MAX,
  uniqueItems: true,
});

/** The address is verified at acceptance; knowing a forwarded link grants no other account access. */
export const CreateGuestInvitationRequest = FromClient({
  email: Type.String({ format: 'email', maxLength: EMAIL_MAX }),
  channelIds: GuestChannelIds,
  accessExpiresAt: Type.Union([Timestamp, Type.Null()]),
  locale: Type.Optional(SignInLocale),
});
export type CreateGuestInvitationRequest = Static<typeof CreateGuestInvitationRequest>;

export const CreatedGuestInvitation = Type.Composite([
  CreatedInvitation,
  Type.Object({
    guest: Type.Object({
      email: Type.String({ format: 'email', maxLength: EMAIL_MAX }),
      channelIds: GuestChannelIds,
      accessExpiresAt: Type.Union([Timestamp, Type.Null()]),
    }),
  }),
]);
export type CreatedGuestInvitation = Static<typeof CreatedGuestInvitation>;

/** Readiness is an operator rollout attestation; email means a relay is configured, not delivered. */
export const GuestInvitationAvailability = Type.Object({
  enabled: Type.Boolean(),
  email: Type.Boolean(),
});
export type GuestInvitationAvailability = Static<typeof GuestInvitationAvailability>;

export const WorkspaceGuest = Type.Object({
  user: User,
  joinedAt: Timestamp,
  access: GuestMembershipAccess,
  /** A removed channel may leave an expired or orphaned scope visible to its administrators. */
  channelIds: Type.Array(Uuid, { maxItems: GUEST_CHANNELS_MAX, uniqueItems: true }),
  /** Private or unavailable channel identities are not disclosed by guest administration. */
  hiddenChannelCount: Type.Integer({ minimum: 0 }),
});
export type WorkspaceGuest = Static<typeof WorkspaceGuest>;

export const WorkspaceGuestPage = Page(WorkspaceGuest);
export type WorkspaceGuestPage = Static<typeof WorkspaceGuestPage>;

export const WorkspaceGuestQuery = FromClient({
  ...OlderPageQuery.properties,
  /** Literal display-name or username text; never account email. */
  q: Type.Optional(Type.String({ maxLength: GUEST_SEARCH_MAX })),
});
export type WorkspaceGuestQuery = Static<typeof WorkspaceGuestQuery>;

/** Clients cannot rewrite history or promote access; explicit reactivation starts a new admission. */
export const UpdateGuestAccessRequest = FromClient(
  {
    channelIds: Type.Optional(
      Type.Array(Uuid, { maxItems: GUEST_CHANNELS_MAX, uniqueItems: true }),
    ),
    accessExpiresAt: Type.Optional(Type.Union([Timestamp, Type.Null()])),
  },
  { minProperties: 1 },
);
export type UpdateGuestAccessRequest = Static<typeof UpdateGuestAccessRequest>;

/** An accepted edit can be applied locally even when the subsequent directory refresh fails. */
export const UpdatedGuestAccess = Type.Pick(WorkspaceGuest, [
  'joinedAt',
  'access',
  'channelIds',
  'hiddenChannelCount',
]);
export type UpdatedGuestAccess = Static<typeof UpdatedGuestAccess>;

/** Widening history and public-channel access requires an explicit acknowledgment. */
export const ConvertGuestRequest = FromClient({ confirmFullAccess: Type.Literal(true) });
export type ConvertGuestRequest = Static<typeof ConvertGuestRequest>;
