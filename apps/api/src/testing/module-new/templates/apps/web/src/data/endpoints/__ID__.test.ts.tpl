/**
 * The __ID__ module's client against the paths `API.md` gives its two endpoints, and the method and body the contract says. The
 * answers are real shapes, so the schema check of `http.ts` is exercised too: an endpoint wired to the wrong schema fails here.
 */
import { describe, expect, test } from 'bun:test';
import { ApiError } from '../errors';
import { createHttp } from '../http';
import { create__PASCAL__Api } from './__ID__';

const ID = '0199155c-8100-7b7f-8c11-2a4d3f9e1b70';
const row = { id: ID, title: 'Fix it', createdAt: '2026-09-09T08:00:00.000Z' };

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const harness = (
  answer: unknown,
  status = 200,
): { api: ReturnType<typeof create__PASCAL__Api>; calls: Call[] } => {
  const calls: Call[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({
      method: String(init.method),
      url,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    return Promise.resolve(new Response(JSON.stringify(answer), { status }));
  }) as unknown as typeof fetch;
  return { api: create__PASCAL__Api(createHttp(fetchFn)), calls };
};

describe('the __ID__ endpoints', () => {
  test('the list is read from the workspace’s path with GET and decoded', async () => {
    const list = harness([row]);
    expect(await list.api.list__PASCAL__(ID)).toEqual([row]);
    expect(list.calls).toEqual([
      { method: 'GET', url: `/api/workspaces/${ID}/__ID__`, body: undefined },
    ]);
  });

  test('a row is made with POST and the title as the body, and the row that comes back is decoded', async () => {
    const make = harness(row, 201);
    expect(await make.api.create__PASCAL__Item(ID, { title: 'Fix it' })).toEqual(row);
    expect(make.calls).toEqual([
      { method: 'POST', url: `/api/workspaces/${ID}/__ID__`, body: { title: 'Fix it' } },
    ]);
  });

  test('an answer that is not the contract’s is refused, and a refusal of the server is an ApiError with its code', async () => {
    const odd = await harness([{ id: 'not-an-id' }])
      .api.list__PASCAL__(ID)
      .then(
        () => 'taken',
        () => 'refused',
      );
    expect(odd).toBe('refused');
    const refused = harness({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'no', details: {} } }, 404);
    const failure = await refused.api.create__PASCAL__Item(ID, { title: 'x' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('WORKSPACE_NOT_FOUND');
  });
});
