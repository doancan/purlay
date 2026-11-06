import {
  InvitationRecipientStatus,
  INVITATION_RECIPIENT_SEARCH_MAX,
  type InvitationRecipientQuery,
} from '@purlay/types';

/** Only this page's valid filters are read from a shared address; pagination starts afresh. */
export const invitationRecipientFilterIn = (search: string): InvitationRecipientQuery => {
  const params = new URLSearchParams(search);
  const q = params.get('q')?.trim() ?? '';
  const status = InvitationRecipientStatus.anyOf.find(
    (item) => item.const === params.get('status'),
  )?.const;
  return {
    ...(q === '' || q.length > INVITATION_RECIPIENT_SEARCH_MAX ? {} : { q }),
    ...(status === undefined ? {} : { status }),
  };
};
