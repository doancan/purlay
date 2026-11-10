/** Restricted channel guests use the existing identity and membership authority (D-300). */
import { Type, type Static } from '@sinclair/typebox';
import { FromClient, GuestMembershipAccess, Timestamp, Uuid, User } from './models';
import { EMAIL_MAX } from './mailbox';
import { CreatedInvitation, Page, SignInLocale } from './api';

/** A guest's channel scope is bounded at admission and every subsequent edit. */
export const GUEST_CHANNELS_MAX = 20;

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

export const WorkspaceGuest = Type.Object({
  user: User,
  joinedAt: Timestamp,
  access: GuestMembershipAccess,
  /** A removed channel may leave an expired or orphaned scope visible to its administrators. */
  channelIds: Type.Array(Uuid, { maxItems: GUEST_CHANNELS_MAX, uniqueItems: true }),
});
export type WorkspaceGuest = Static<typeof WorkspaceGuest>;

export const WorkspaceGuestPage = Page(WorkspaceGuest);
export type WorkspaceGuestPage = Static<typeof WorkspaceGuestPage>;

/** Changing a scope never changes its history floor or silently promotes the guest to full membership. */
export const UpdateGuestAccessRequest = FromClient(
  {
    channelIds: Type.Optional(GuestChannelIds),
    accessExpiresAt: Type.Optional(Type.Union([Timestamp, Type.Null()])),
  },
  { minProperties: 1 },
);
export type UpdateGuestAccessRequest = Static<typeof UpdateGuestAccessRequest>;
