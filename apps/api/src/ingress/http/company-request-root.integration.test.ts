/** Native auth work after a real HTTP request does not inherit that request's company scope. @needs-modules chat */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { systemClock } from '../../platform/clock';
import { currentRequest } from '../../platform/logging';
import { signInCompanyNative } from '../../testing/company-native-auth';
import { testDependencies } from '../../testing/doubles';
import { createApp } from './app';

let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

describe('integration: real company HTTP request roots', () => {
  test('a company request on the listener leaves subsequent native auth in its own independent root', async () => {
    const first = await signInCompanyNative(clone.db);
    const app = createApp(
      testDependencies({ database: clone.db, auth: first.auth, clock: systemClock }),
    );
    const port = app.listen(0);
    try {
      expect(currentRequest()).toBeUndefined();
      const response = await fetch(`http://localhost:${String(port)}/api/me`, {
        headers: { cookie: first.cookie },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        companyWorkspaceId: first.fixture.member.context.workspaceId,
      });
      expect(currentRequest()).toBeUndefined();
      const second = await signInCompanyNative(clone.db);
      expect(second.companySession.companyWorkspaceId).not.toBe(
        first.companySession.companyWorkspaceId,
      );
      expect(currentRequest()).toBeUndefined();
    } finally {
      await app.stop(true);
    }
  });
});
