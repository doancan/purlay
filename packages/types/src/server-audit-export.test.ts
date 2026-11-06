import { expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { ServerAuditExportQuery } from './server-administration';

test('a server audit export has an explicit format, the same filters, and no page or content escape hatch', () => {
  for (const format of ['csv', 'ndjson']) {
    expect(
      Value.Check(ServerAuditExportQuery, {
        format,
        action: 'server.smtp_tested',
        from: '2026-11-01T00:00:00Z',
      }),
    ).toBe(true);
  }
  for (const query of [
    {},
    { format: 'json' },
    { format: 'csv', after: 'anything' },
    { format: 'csv', limit: 100 },
    { format: 'csv', actorUserId: 'invalid' },
    { format: 'csv', includeSecrets: true },
  ]) {
    expect(Value.Check(ServerAuditExportQuery, query)).toBe(false);
  }
});
