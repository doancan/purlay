/**
 * The half a compiler can check.
 *
 * `ChannelContext` claims a channel-scoped call cannot be written without having
 * passed the visibility guard. That is a claim about what fails to compile, so
 * the assertions are `@ts-expect-error` lines: if the error they name stops
 * happening, TypeScript reports the unused directive and the build fails.
 *
 * That the type is inhabited is proved by `channels.ts` compiling — it builds
 * one. The runtime half is `channels.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import type { ChannelContext } from './channels';
import type { WorkspaceContext } from './tenancy';

const channelScopedRead = (context: ChannelContext): string => context.channelId;

/**
 * Declared, never asserted. `as WorkspaceContext` is a lint error everywhere —
 * with no exemption, including here (D-54) — and this file found that out by
 * being written the other way first.
 */
declare const workspace: WorkspaceContext;

/** Never called. Its body is the assertion, and the compiler is what runs it. */
export const compileTimeAssertions = (): void => {
  // @ts-expect-error a plain object cannot satisfy the brand — its key is a symbol this file cannot name (D-54)
  channelScopedRead({ workspaceId: 'w', channelId: 'c', channelType: 'public', userId: 'u' });
  // @ts-expect-error a channel-scoped read with no context at all does not compile (D-34)
  channelScopedRead();
  // @ts-expect-error the two axes are not interchangeable: a workspace context is not a channel one
  channelScopedRead(workspace);
};

describe('the two contexts are different capabilities', () => {
  /**
   * Both brands are symbol-keyed, so neither satisfies the other. The assertion
   * above is what proves it; this records why it matters — passing a workspace
   * context where a channel one is required would mean a member of the workspace
   * reading a channel they are not in.
   */
  test('this file exists to make the compiler assert, so it has nothing to run', () => {
    expect(typeof compileTimeAssertions).toBe('function');
  });
});
