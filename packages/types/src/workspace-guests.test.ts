import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  CreateGuestInvitationRequest,
  GUEST_CHANNELS_MAX,
  UpdateGuestAccessRequest,
} from './workspace-guests';

const request = (): unknown => ({
  email: 'supplier@example.test',
  channelIds: [crypto.randomUUID()],
  accessExpiresAt: null,
});

describe('restricted guest request contracts', () => {
  test('requires a verified-at-acceptance address, explicit channels and an explicit expiry choice', () => {
    expect(Value.Check(CreateGuestInvitationRequest, request())).toBe(true);
    expect(Value.Check(CreateGuestInvitationRequest, {})).toBe(false);
    expect(
      Value.Check(CreateGuestInvitationRequest, { email: 'supplier@example.test', channelIds: [] }),
    ).toBe(false);
  });
  test('refuses repeated, malformed, oversized or hidden privilege fields', () => {
    const id = crypto.randomUUID();
    for (const channelIds of [
      [],
      [id, id],
      ['wrong-id'],
      Array.from({ length: GUEST_CHANNELS_MAX + 1 }, () => crypto.randomUUID()),
    ]) {
      expect(
        Value.Check(CreateGuestInvitationRequest, {
          email: 'supplier@example.test',
          channelIds,
          accessExpiresAt: null,
        }),
      ).toBe(false);
    }
    expect(
      Value.Check(CreateGuestInvitationRequest, {
        email: 'supplier@example.test',
        channelIds: [id],
        accessExpiresAt: null,
        role: 'owner',
      }),
    ).toBe(false);
  });
  test('an access edit cannot rewrite the history floor or convert the guest', () => {
    expect(Value.Check(UpdateGuestAccessRequest, {})).toBe(false);
    expect(Value.Check(UpdateGuestAccessRequest, { accessExpiresAt: null })).toBe(true);
    expect(Value.Check(UpdateGuestAccessRequest, { historySince: '2000-01-01T00:00:00Z' })).toBe(
      false,
    );
    expect(Value.Check(UpdateGuestAccessRequest, { kind: 'member' })).toBe(false);
  });
});
