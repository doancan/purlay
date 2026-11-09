/**
 * A job written per workspace (D-289 §10): the framework walks the workspaces the module may act for, calls the visit with each and
 * adds up its counts. Which workspaces those are is `platform/entitled-workspaces.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { sql } from '@purlay/db';
import {
  isPerWorkspace,
  noEntitledWorkspaces,
  type EntitledWorkspaces,
} from '../../platform/entitled-workspaces';
import { fixedClock } from '../../platform/clock';
import { aDatabaseThatMustNotBeTouched, aRecordingLogger } from '../../testing/doubles';
import { aMemoryStore } from '../../testing/storage';
import { perWorkspaceJob, type JobContext } from './jobs';

const contextOver = (entitled: EntitledWorkspaces): JobContext => ({
  database: aDatabaseThatMustNotBeTouched(),
  clock: fixedClock(new Date('2026-01-01T00:00:00Z')),
  log: aRecordingLogger().log,
  storage: aMemoryStore(),
  appUrl: 'http://localhost:3000',
  entitled,
  withMailer: async (use): ReturnType<typeof use> => await use(undefined),
});

const turnsOf = (ids: readonly string[]): EntitledWorkspaces => ({
  has: () => sql<boolean>`true`,
  turns: (after) =>
    Promise.resolve(
      ids
        .filter((id) => after === undefined || id > after)
        .map((workspaceId) => ({ workspaceId, modules: null })),
    ),
});

describe('a job written per workspace', () => {
  test('is visited once for each workspace the module may act for, and its counts are added up', async () => {
    const seen: string[] = [];
    const job = perWorkspaceJob((turn) => {
      seen.push(turn.workspaceId);
      return Promise.resolve({ sent: 2 });
    });
    expect(isPerWorkspace(job)).toBe(true);
    expect(await job(contextOver(turnsOf(['a', 'b', 'c'])))).toEqual({ workspaces: 3, sent: 6 });
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  test('does nothing where no workspace is entitled', async () => {
    const job = perWorkspaceJob(() =>
      Promise.reject(new Error('visited a workspace nobody may act for')),
    );
    expect(await job(contextOver(noEntitledWorkspaces))).toEqual({ workspaces: 0 });
    expect(noEntitledWorkspaces.has('x.workspace_id')).toBeDefined();
  });
});
