/** Restricted channel guests use the existing identity and membership authority (D-300). */
import { Type, type Static } from '@sinclair/typebox';
import { FromClient, GuestMembershipAccess, Timestamp, Uuid, User } from './models';
import { EMAIL_MAX } from './mailbox';
import { CreatedInvitation, OlderPageQuery, Page, SignInLocale } from './api';

// Schema builders have no registration side effects. Keep server-only request construction out
// of browser bundles, as the find contract does; imported validators still build normally.

/** A guest's channel scope is bounded at admission and every subsequent edit. */
export const GUEST_CHANNELS_MAX = 20;
export const GUEST_SEARCH_MAX = 100;

export const GuestChannelIds = /* @__PURE__ */ Type.Array(Uuid, {
  minItems: 1,
  maxItems: GUEST_CHANNELS_MAX,
  uniqueItems: true,
});

/** The address is verified at acceptance; knowing a forwarded link grants no other account access. */
export const CreateGuestInvitationRequest = /* @__PURE__ */ FromClient({
  email: /* @__PURE__ */ Type.String({ format: 'email', maxLength: EMAIL_MAX }),
  channelIds: GuestChannelIds,
  accessExpiresAt: /* @__PURE__ */ Type.Union([Timestamp, /* @__PURE__ */ Type.Null()]),
  locale: /* @__PURE__ */ Type.Optional(SignInLocale),
});
export type CreateGuestInvitationRequest = Static<typeof CreateGuestInvitationRequest>;

export const CreatedGuestInvitation = /* @__PURE__ */ Type.Composite([
  CreatedInvitation,
  /* @__PURE__ */ Type.Object({
    guest: /* @__PURE__ */ Type.Object({
      email: /* @__PURE__ */ Type.String({ format: 'email', maxLength: EMAIL_MAX }),
      channelIds: GuestChannelIds,
      accessExpiresAt: /* @__PURE__ */ Type.Union([Timestamp, /* @__PURE__ */ Type.Null()]),
    }),
  }),
]);
export type CreatedGuestInvitation = Static<typeof CreatedGuestInvitation>;

/** Readiness is an operator rollout attestation; email means a relay is configured, not delivered. */
export const GuestInvitationAvailability = /* @__PURE__ */ Type.Object({
  enabled: /* @__PURE__ */ Type.Boolean(),
  email: /* @__PURE__ */ Type.Boolean(),
});
export type GuestInvitationAvailability = Static<typeof GuestInvitationAvailability>;

export const WorkspaceGuest = /* @__PURE__ */ Type.Object({
  user: User,
  joinedAt: Timestamp,
  access: GuestMembershipAccess,
  /** A removed channel may leave an expired or orphaned scope visible to its administrators. */
  channelIds: /* @__PURE__ */ Type.Array(Uuid, { maxItems: GUEST_CHANNELS_MAX, uniqueItems: true }),
  /** Private or unavailable channel identities are not disclosed by guest administration. */
  hiddenChannelCount: /* @__PURE__ */ Type.Integer({ minimum: 0 }),
});
export type WorkspaceGuest = Static<typeof WorkspaceGuest>;

export const WorkspaceGuestPage = /* @__PURE__ */ Page(WorkspaceGuest);
export type WorkspaceGuestPage = Static<typeof WorkspaceGuestPage>;

export const WorkspaceGuestQuery = /* @__PURE__ */ FromClient({
  ...OlderPageQuery.properties,
  /** Literal display-name or username text; never account email. */
  q: /* @__PURE__ */ Type.Optional(/* @__PURE__ */ Type.String({ maxLength: GUEST_SEARCH_MAX })),
});
export type WorkspaceGuestQuery = Static<typeof WorkspaceGuestQuery>;

/** Clients cannot rewrite history or promote access; explicit reactivation starts a new admission. */
export const UpdateGuestAccessRequest = /* @__PURE__ */ FromClient(
  {
    channelIds: /* @__PURE__ */ Type.Optional(
      /* @__PURE__ */ Type.Array(Uuid, { maxItems: GUEST_CHANNELS_MAX, uniqueItems: true }),
    ),
    accessExpiresAt: /* @__PURE__ */ Type.Optional(
      /* @__PURE__ */ Type.Union([Timestamp, /* @__PURE__ */ Type.Null()]),
    ),
  },
  { minProperties: 1 },
);
export type UpdateGuestAccessRequest = Static<typeof UpdateGuestAccessRequest>;

/** An accepted edit can be applied locally even when the subsequent directory refresh fails. */
export const UpdatedGuestAccess = /* @__PURE__ */ Type.Pick(WorkspaceGuest, [
  'joinedAt',
  'access',
  'channelIds',
  'hiddenChannelCount',
]);
export type UpdatedGuestAccess = Static<typeof UpdatedGuestAccess>;

/** Widening history and public-channel access requires an explicit acknowledgment. */
export const ConvertGuestRequest = /* @__PURE__ */ FromClient({
  confirmFullAccess: /* @__PURE__ */ Type.Literal(true),
});
export type ConvertGuestRequest = Static<typeof ConvertGuestRequest>;
