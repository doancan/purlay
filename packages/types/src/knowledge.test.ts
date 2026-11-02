import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { SetKnowledgeRequest, SearchQuery, SaveSearchRequest } from './api';

const ID = '01957cb4-a800-7000-8000-000000000001';
const input = {
  version: 0,
  isQuestion: true,
  assigneeId: null,
  acceptedAnswerId: null,
  decisionNote: 'Wait four seconds to respect the upstream limit.',
  decisionUrl: null,
};

describe('question knowledge and search contract', () => {
  test('metadata is versioned, bounded and rejects undeclared input', () => {
    expect(Value.Check(SetKnowledgeRequest, input)).toBe(true);
    for (const invalid of [
      { ...input, version: -1 },
      { ...input, version: 0.5 },
      { ...input, acceptedAnswerId: 'not-an-id' },
      { ...input, decisionNote: 'x'.repeat(2001) },
      { ...input, decisionNote: '\u0000' },
      { ...input, decisionUrl: 'javascript:alert(1)' },
      { ...input, surprise: true },
    ])
      expect(Value.Check(SetKnowledgeRequest, invalid)).toBe(false);
  });

  test('filters compose without repurposing the UUID page cursor', () => {
    expect(
      Value.Check(SearchQuery, {
        q: 'retry',
        before: ID,
        status: 'resolved',
        kind: 'code',
        since: '2026-10-01T00:00:00Z',
        until: '2026-11-01T00:00:00Z',
        repository: 'acme/api',
        question: 'yes',
      }),
    ).toBe(true);
    expect(Value.Check(SearchQuery, { q: '', status: 'resolved' })).toBe(true);
    for (const invalid of [
      { q: 'a' },
      { q: 'retry', status: 'done' },
      { q: 'retry', since: 'yesterday' },
      { q: 'retry', repository: '../api' },
    ])
      expect(Value.Check(SearchQuery, invalid)).toBe(false);
  });

  test('saved searches contain filters, never a cursor or fetched results', () => {
    expect(
      Value.Check(SaveSearchRequest, {
        name: 'Retry decisions',
        query: { q: 'retry', status: 'resolved' },
      }),
    ).toBe(true);
    expect(
      Value.Check(SaveSearchRequest, { name: 'Retry', query: { q: 'retry', before: ID } }),
    ).toBe(false);
    expect(Value.Check(SaveSearchRequest, { name: '', query: { q: 'retry' } })).toBe(false);
  });
});
