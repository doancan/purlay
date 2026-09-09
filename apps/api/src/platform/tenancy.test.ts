/**
 * The half of the guarantee a compiler can check.
 *
 * `WorkspaceContext` claims that a workspace-scoped call cannot be written
 * without having passed the guard. That is a claim about what fails to compile,
 * so the assertions are `@ts-expect-error` lines rather than expectations: if the
 * error they name ever stops happening, TypeScript reports the unused directive
 * and the build fails. A comment saying "this would not compile" proves nothing.
 *
 * That the type is *inhabited* is proved by `tenancy.ts` compiling at all — it
 * builds one. An uninhabited brand would make every assertion below pass while
 * meaning nothing. The runtime half — a non-member gets 404 and learns nothing —
 * is `tenancy.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { ErrorResponse } from '@purlay/types';
import { AppError } from './errors';
import type { WorkspaceContext } from './tenancy';

/**
 * Stands in for the workspace-scoped repositories that arrive with the workspace,
 * channel and message modules: context first, filter applied internally.
 */
const scopedRead = (context: WorkspaceContext): string => context.workspaceId;

/**
 * Never called. Its body is the assertion, and the compiler is what runs it.
 * Calling it would only prove that JavaScript ignores types.
 */
export const compileTimeAssertions = (): void => {
  // @ts-expect-error a plain object cannot satisfy the brand — its key is a symbol this file cannot name (D-54)
  scopedRead({ workspaceId: 'w', userId: 'u', role: 'member' });
  // @ts-expect-error a workspace-scoped read with no context at all does not compile (D-21)
  scopedRead();
};

describe('AppError', () => {
  test('the status comes from the code, so two call sites cannot disagree', () => {
    const error = new AppError({ code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found.' });
    expect(error.status).toBe(404);
    expect(error).toBeInstanceOf(Error);
  });

  test('what it sends is the envelope the contract describes', () => {
    const error = new AppError({ code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found.' });
    expect(Value.Check(ErrorResponse, error.response)).toBe(true);
  });

  /** Only `VALIDATION_FAILED` carries details, and it cannot be raised without them. */
  test('a validation failure carries its fields', () => {
    const error = new AppError({
      code: 'VALIDATION_FAILED',
      message: 'bad',
      details: { fields: { slug: 'must be lowercase' } },
    });
    expect(error.status).toBe(400);
    expect(Value.Check(ErrorResponse, error.response)).toBe(true);
  });
});
