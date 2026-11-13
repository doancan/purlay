import { expect, test } from 'bun:test';
import { aDatabaseThatMustNotBeTouched } from '../testing/doubles';
import { withinRequest } from './logging';
import { requireWorkspaceContentAccess } from './workspace-content-access';

const user = '01935a51-0000-7000-8000-000000000001';
const workspace = '01935a51-0000-7000-8000-000000000002';

test('ungoverned membership keeps its old query cost and needs no request scope', async () => {
  await requireWorkspaceContentAccess(aDatabaseThatMustNotBeTouched(), user, workspace, '0');
});

test('governed content refuses missing provenance with an exact workspace hint', async () => {
  expect(
    await requireWorkspaceContentAccess(
      aDatabaseThatMustNotBeTouched(),
      user,
      workspace,
      '1',
    ).catch((error: unknown) => error),
  ).toMatchObject({
    status: 403,
    body: { code: 'WORKSPACE_ACCESS_REQUIRED', details: { workspaceId: workspace } },
  });
});

test('the native request port receives the actual executor, user and workspace', async () => {
  const db = aDatabaseThatMustNotBeTouched();
  let calls = 0;
  await withinRequest(
    {
      requestId: 'workspace-proof',
      startedAt: 0,
      workspaceAccess: (executor, userId, workspaceId): Promise<void> => {
        expect(executor).toBe(db);
        expect(userId).toBe(user);
        expect(workspaceId).toBe(workspace);
        calls += 1;
        return Promise.resolve();
      },
    },
    async () => {
      await requireWorkspaceContentAccess(db, user, workspace, '8');
      await requireWorkspaceContentAccess(db, user, workspace, '0');
    },
  );
  expect(calls).toBe(1);
});
