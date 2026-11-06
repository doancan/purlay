import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  ServerAuditQuery,
  ServerUsersQuery,
  ServerWorkspacesQuery,
  ServerQuotaRequest,
} from './server-administration';

describe('server administration requests', () => {
  test.each([ServerUsersQuery, ServerWorkspacesQuery, ServerAuditQuery])(
    'lists have bounded keyset pagination and refuse unknown or ambiguous inputs',
    (schema) => {
      expect(Value.Check(schema, {})).toBe(true);
      expect(Value.Check(schema, { limit: 100 })).toBe(true);
      for (const input of [
        { limit: 0 },
        { limit: 101 },
        { limit: 1.5 },
        { after: 'no-id' },
        { offset: 20 },
      ]) {
        expect(Value.Check(schema, input)).toBe(false);
      }
    },
  );

  test('account and workspace filters belong to their respective lists', () => {
    expect(Value.Check(ServerUsersQuery, { status: 'suspended' })).toBe(true);
    expect(Value.Check(ServerUsersQuery, { status: 'deleted' })).toBe(false);
    expect(Value.Check(ServerWorkspacesQuery, { status: 'deleted' })).toBe(true);
    expect(Value.Check(ServerWorkspacesQuery, { status: 'suspended' })).toBe(false);
  });

  test('quota is an exact, non-negative wire integer, never a rounded or unbounded number', () => {
    expect(Value.Check(ServerQuotaRequest, { quotaBytes: 0 })).toBe(true);
    expect(Value.Check(ServerQuotaRequest, { quotaBytes: Number.MAX_SAFE_INTEGER })).toBe(true);
    for (const quotaBytes of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, '5GiB']) {
      expect(Value.Check(ServerQuotaRequest, { quotaBytes })).toBe(false);
    }
    expect(Value.Check(ServerQuotaRequest, { quotaBytes: 1, workspaceId: 'another' })).toBe(false);
  });

  test('an audit filter cannot become a request for a credential or raw message', () => {
    expect(Value.Check(ServerAuditQuery, { action: 'server.smtp_connected' })).toBe(true);
    expect(Value.Check(ServerAuditQuery, { action: 'password' })).toBe(false);
    expect(Value.Check(ServerAuditQuery, { content: 'private message' })).toBe(false);
    expect(Value.Check(ServerAuditQuery, { from: 'not-a-date' })).toBe(false);
  });
});
