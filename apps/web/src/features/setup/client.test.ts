/**
 * The wizard's client: which request each call sends, how an answer is checked, and how a failure
 * is told apart (status, `Retry-After`, the fields and the reason of a refusal).
 */
import { describe, expect, test } from 'bun:test';
import { createSetupClient, isSetupFailure, type SetupFailure, type SetupFetch } from './client';
import { aState } from './testing';

interface Seen {
  readonly path: string;
  readonly init: RequestInit;
}

const respond = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): { readonly seen: Seen[]; readonly fetch: SetupFetch } => {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: (path, init): Promise<Response> => {
      seen.push({ path, init });
      return Promise.resolve(new Response(body, { status, headers }));
    },
  };
};

const ok = (json: unknown): ReturnType<typeof respond> => respond(200, JSON.stringify(json));

const failureOf = async (promise: Promise<unknown>): Promise<SetupFailure> => {
  try {
    await promise;
  } catch (error) {
    if (isSetupFailure(error)) return error;
    throw error;
  }
  throw new Error('the call did not fail');
};

describe('the requests the wizard sends', () => {
  test('sends each call to its path with its body, as JSON on the same origin', async () => {
    const world = respond(204, '');
    const client = createSetupClient(world.fetch);
    await client.claim('ABC123');
    await client.confirmAddress();
    await client.policy('open');
    await client.skipGithub();
    await client.skipSmtp();
    await client.workspace({ name: 'Acme', slug: 'acme' });
    await client.invite();
    await client.finish();
    expect(world.seen.map((one) => [one.path, one.init.method, one.init.body])).toEqual([
      ['/setup/claim', 'POST', '{"code":"ABC123"}'],
      ['/setup/address', 'POST', '{"confirmed":true}'],
      ['/setup/policy', 'POST', '{"signUp":"open"}'],
      ['/setup/github', 'POST', '{"skip":true}'],
      ['/setup/smtp', 'POST', '{"skip":true}'],
      ['/setup/workspace', 'POST', '{"name":"Acme","slug":"acme"}'],
      ['/setup/invite', 'POST', undefined],
      ['/setup/finish', 'POST', undefined],
    ]);
    for (const one of world.seen) expect(one.init.credentials).toBe('same-origin');
    expect(world.seen[0]?.init.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
    });
    expect(world.seen[6]?.init.headers).toEqual({ accept: 'application/json' });
  });

  test('reads the state with GET and passes the abort signal on', async () => {
    const world = ok(aState());
    const controller = new AbortController();
    const state = await createSetupClient(world.fetch).state(controller.signal);
    expect(state.appUrl).toBe(aState().appUrl);
    expect(world.seen[0]?.path).toBe('/setup/state');
    expect(world.seen[0]?.init.method).toBe('GET');
    expect(world.seen[0]?.init.signal).toBe(controller.signal);
  });

  test('sends the administrator and says whether they are signed in', async () => {
    const world = ok({ signedIn: true, extra: 1 });
    const answer = await createSetupClient(world.fetch).admin({
      name: 'Ada',
      email: 'ada@example.test',
      password: 'a long enough passphrase',
    });
    expect(answer).toEqual({ signedIn: true });
    expect(world.seen[0]?.init.body).toBe(
      '{"name":"Ada","email":"ada@example.test","password":"a long enough passphrase"}',
    );
  });

  test('sends the GitHub and mail tries and returns the verdict', async () => {
    const github = ok({ ok: false, reason: 'unexpected-reply', raw: 'nope' });
    const verdict = await createSetupClient(github.fetch).github({
      clientId: 'id',
      clientSecret: 'secret',
      save: false,
    });
    expect(verdict).toEqual({ ok: false, reason: 'unexpected-reply', raw: 'nope' });
    expect(github.seen[0]?.path).toBe('/setup/github');
    expect(github.seen[0]?.init.body).toBe(
      '{"clientId":"id","clientSecret":"secret","save":false}',
    );

    const smtp = ok({ ok: true });
    const sent = await createSetupClient(smtp.fetch).smtp({
      smtpUrl: 'smtp://x',
      from: 'a@b.test',
      allowPlaintext: true,
      locale: 'tr',
      save: true,
    });
    expect(sent).toEqual({ ok: true });
    expect(smtp.seen[0]?.path).toBe('/setup/smtp');
  });

  test('sends the verification token and answers verified', async () => {
    const world = ok({ verified: true });
    expect(await createSetupClient(world.fetch).verify('tok')).toEqual({ verified: true });
    expect(world.seen[0]?.init.body).toBe('{"token":"tok"}');
  });
});

type Call = (client: ReturnType<typeof createSetupClient>) => Promise<unknown>;

describe('an answer the browser does not trust', () => {
  const malformedCases: readonly (readonly [string, Call, unknown])[] = [
    ['a state without its steps', (c): Promise<unknown> => c.state(), { appUrl: 'x' }],
    [
      'a state with a step that does not exist',
      (c): Promise<unknown> => c.state(),
      { ...aState(), steps: ['nope'] },
    ],
    [
      'an admin answer without signedIn',
      (c): Promise<unknown> => c.admin({ name: 'a', email: 'b', password: 'c' }),
      {},
    ],
    [
      'a verdict with an unknown reason',
      (c): Promise<unknown> => c.github({ clientId: 'a', clientSecret: 'b', save: false }),
      { ok: false, reason: 'weird', raw: '' },
    ],
    [
      'a mail verdict that is not an object',
      (c): Promise<unknown> =>
        c.smtp({ smtpUrl: 'a', from: 'b', allowPlaintext: false, locale: 'en', save: false }),
      'text',
    ],
    [
      'a verification that is not verified',
      (c): Promise<unknown> => c.verify('t'),
      { verified: false },
    ],
  ];
  for (const [name, call, body] of malformedCases) {
    test(`refuses ${name} as MALFORMED`, async () => {
      const failure = await failureOf(call(createSetupClient(ok(body).fetch)));
      expect(failure.code).toBe('MALFORMED');
      expect(failure.status).toBe(200);
    });
  }

  test('refuses a success whose body is not JSON', async () => {
    const failure = await failureOf(createSetupClient(respond(200, '<html>').fetch).invite());
    expect(failure.code).toBe('MALFORMED');
  });
});

describe('a failure, told apart', () => {
  test('carries the code, the message, the fields and the reason of a refusal', async () => {
    const body = JSON.stringify({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'no',
        details: { fields: { password: 'too-short', n: 3 }, reason: 'admin-exists' },
      },
    });
    const failure = await failureOf(
      createSetupClient(respond(422, body, { 'retry-after': '90' }).fetch).invite(),
    );
    expect(failure.code).toBe('VALIDATION_FAILED');
    expect(failure.status).toBe(422);
    expect(failure.message).toBe('no');
    expect(failure.retryAfter).toBe(90);
    expect(failure.fields).toEqual({ password: 'too-short' });
    expect(failure.refusal).toBe('admin-exists');
    expect(failure.reason).toBe('admin-exists');
  });

  test('keeps a reason that is not a refusal as the reason only', async () => {
    const body = JSON.stringify({ error: { code: 'CONFLICT', details: { reason: 'other' } } });
    const failure = await failureOf(createSetupClient(respond(409, body).fetch).invite());
    expect(failure.refusal).toBeNull();
    expect(failure.reason).toBe('other');
    expect(failure.message).toBe('');
    expect(failure.retryAfter).toBeNull();
  });

  test('ignores a Retry-After that is not whole seconds', async () => {
    const body = JSON.stringify({ error: { code: 'RATE_LIMITED' } });
    const failure = await failureOf(
      createSetupClient(respond(429, body, { 'retry-after': 'soon' }).fetch).invite(),
    );
    expect(failure.retryAfter).toBeNull();
  });

  test('reads a gateway page as the server being unreachable', async () => {
    for (const status of [502, 503, 504]) {
      const failure = await failureOf(
        createSetupClient(respond(status, 'Bad gateway').fetch).invite(),
      );
      expect(failure.code).toBe('NETWORK');
    }
  });

  test('reads any other page that is not JSON as unreadable', async () => {
    const failure = await failureOf(createSetupClient(respond(500, 'oops').fetch).invite());
    expect(failure.code).toBe('MALFORMED');
  });

  test('reads JSON without an error code as unreadable', async () => {
    const failure = await failureOf(
      createSetupClient(respond(400, JSON.stringify({ error: {} })).fetch).invite(),
    );
    expect(failure.code).toBe('MALFORMED');
  });

  test('says NETWORK when the request itself fails, with the reason it gave', async () => {
    const client = createSetupClient(() => Promise.reject(new Error('offline')));
    const failure = await failureOf(client.invite());
    expect(failure.code).toBe('NETWORK');
    expect(failure.status).toBe(0);
    expect(failure.message).toBe('offline');
  });

  test('says NETWORK with a plain message when what was thrown is not an Error', async () => {
    // A promise can be rejected with anything; the type says Error, the browser does not promise it.
    const notAnError = 'gone' as unknown as Error;
    const client = createSetupClient(() => Promise.reject(notAnError));
    expect((await failureOf(client.invite())).message).toBe('No answer.');
  });

  test('says NETWORK when the answer stops before it is whole', async () => {
    const broken = {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => Promise.reject(new Error('cut')),
    } as unknown as Response;
    const failure = await failureOf(createSetupClient(() => Promise.resolve(broken)).invite());
    expect(failure.code).toBe('NETWORK');
    expect(failure.message).toBe('The answer stopped before it was whole.');
  });
});
