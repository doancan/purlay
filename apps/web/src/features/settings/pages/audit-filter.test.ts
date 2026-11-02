/**
 * The Audit log's filter between the address and the server (D-222): only its own vocabulary is read
 * back, days stay days in the address, and become the instants they begin where the reader is.
 */
import { describe, expect, test } from 'bun:test';
import { createFormatters } from '../../../i18n/format';
import {
  NO_FILTER,
  auditExportHref,
  auditFilterOf,
  auditSearchOf,
  auditViewIn,
  isBackwards,
  isNarrowed,
} from './audit-filter';

const PERSON = '0199155c-6200-7b7f-8c11-2a4d3f9e1b70';

describe('the filter in the address', () => {
  test('is read back as it was written', () => {
    const view = {
      actorId: PERSON,
      action: 'member.removed',
      from: '2026-10-01',
      to: '2026-10-31',
    } as const;
    expect(auditViewIn(`?${auditSearchOf(view)}`)).toEqual(view);
    expect(auditSearchOf(NO_FILTER)).toBe('');
    expect(isNarrowed(NO_FILTER)).toBe(false);
    expect(isNarrowed(view)).toBe(true);
  });

  test('leaves out what is not its own: an id that is not one, an unknown action, a day that does not exist', () => {
    expect(
      auditViewIn('?actor=vedat&action=workspace.deleted&from=2026-02-30&to=31-10-2026&colour=red'),
    ).toEqual(NO_FILTER);
    expect(auditViewIn(`?actor=${PERSON.toUpperCase()}`).actorId).toBeNull();
    expect(auditViewIn('?from=2028-02-29').from).toBe('2028-02-29');
  });

  test('a last day before the first is backwards; the same day is a window of one day', () => {
    expect(isBackwards({ ...NO_FILTER, from: '2026-10-31', to: '2026-10-01' })).toBe(true);
    expect(isBackwards({ ...NO_FILTER, from: '2026-10-31', to: '2026-10-31' })).toBe(false);
    expect(isBackwards({ ...NO_FILTER, to: '2026-10-01' })).toBe(false);
  });
});

describe('the filter the server is asked', () => {
  test('a day becomes the instant it begins in the reader’s zone; the last day is in it whole', () => {
    const istanbul = createFormatters('tr', 'Europe/Istanbul').dayStart;
    expect(auditFilterOf({ ...NO_FILTER, from: '2026-10-31', to: '2026-10-31' }, istanbul)).toEqual(
      { from: '2026-10-30T21:00:00.000Z', to: '2026-10-31T21:00:00.000Z' },
    );
    // Across the end of a month and a year.
    const utc = createFormatters('en', 'UTC').dayStart;
    expect(auditFilterOf({ ...NO_FILTER, to: '2026-12-31' }, utc)).toEqual({
      to: '2027-01-01T00:00:00.000Z',
    });
    expect(auditFilterOf(NO_FILTER, utc)).toEqual({});
    expect(auditFilterOf({ ...NO_FILTER, actorId: PERSON, action: 'member.left' }, utc)).toEqual({
      actorId: PERSON,
      action: 'member.left',
    });
  });

  test('downloads from the workspace’s own address, with the filter and the format', () => {
    const href = auditExportHref(
      'w/1',
      { action: 'member.left', from: '2026-10-01T00:00:00.000Z' },
      'ndjson',
    );
    expect(href).toBe(
      '/api/workspaces/w%2F1/audit/export?action=member.left&from=2026-10-01T00%3A00%3A00.000Z&format=ndjson',
    );
  });
});
