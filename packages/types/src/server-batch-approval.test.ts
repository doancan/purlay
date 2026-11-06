import { expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { ServerBatchApprovalRequest, SERVER_APPROVAL_BATCH_MAX } from './server-administration';

test('batch approval accepts a bounded unique list of accounts, never a force flag or implicit all', () => {
  const ids = Array.from({ length: SERVER_APPROVAL_BATCH_MAX }, () => crypto.randomUUID());
  expect(Value.Check(ServerBatchApprovalRequest, { userIds: ids })).toBe(true);
  for (const input of [
    { userIds: [] },
    { userIds: [...ids, crypto.randomUUID()] },
    { userIds: [ids[0], ids[0]] },
    { userIds: ['invalid'] },
    { all: true },
    { userIds: ids, force: true },
  ]) {
    expect(Value.Check(ServerBatchApprovalRequest, input)).toBe(false);
  }
});
