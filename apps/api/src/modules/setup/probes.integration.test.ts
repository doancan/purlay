/**
 * The setup's tries of GitHub and of a relay (D-179 §4.4, Ruling R47), against real sockets: the strict
 * GitHub stub on a port and servers of each kind that fails — closed, silent, untrusted, not GitHub —
 * and a scripted SMTP relay (`testing/smtp-relay.ts`) spoken to by the real transport, TLS included.
 * Each reason is met the way the service gives it, and each reply is read for the secrets it must not
 * carry.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { systemClock } from '../../platform/clock';
import { createLogger } from '../../platform/logging';
import { PROBE_REASONS, type ProbeReason, type ProbeResult } from '@purlay/types';
import { smtpTransport, textLetter, type SmtpTransportFactory } from '../../platform/mail';
import { aSelfSignedCertificate } from '../../testing/certificate';
import { aGitHubStub, GITHUB_STUB_CREDENTIALS } from '../../testing/github-stub';
import { aClosedPort, aScriptedRelay, type RelayScript } from '../../testing/smtp-relay';
import { aGitHubPerson } from '../../testing/github-sign-in';
import { aFloodingServer, aRedirectingServer } from '../../testing/hostile-servers';
import {
  anOidcStub,
  OIDC_STUB_CREDENTIALS,
  type OidcBehaviour,
  type OidcStub,
} from '../../testing/oidc-stub';
import {
  CandidateRefused,
  GITHUB_PROBE_CODE,
  GITHUB_PROBE_TIMEOUT_MS,
  OIDC_PROBE_CODE,
  probeGitHub,
  probeOidc,
  probeSmtp,
  RAW_MAX,
  rawReply,
  SMTP_PHASE_MS,
  SMTP_PROBE_TIMEOUT_MS,
} from './probes';
import { claimSetup, issueSetupCode, requireSetupClaim, type SetupSession } from './setup';

/**
 * The authority every probe takes (Ruling R48): a session the setup's guard minted, on a server of the
 * file's own — the only way to have one.
 */
let AUTHORITY: SetupSession;
let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  const lines: string[] = [];
  await issueSetupCode(
    cloned.db,
    createLogger({ level: 'debug', write: (line) => lines.push(line) }),
    systemClock,
  );
  const code = lines
    .map((line) => (JSON.parse(line) as { setupCode?: unknown }).setupCode)
    .find((value): value is string => typeof value === 'string');
  if (code === undefined) throw new Error('no setup code was written');
  const { claimToken } = await claimSetup(cloned.db, code, 'probe-tests', systemClock);
  AUTHORITY = await requireSetupClaim(cloned.db, claimToken, systemClock);
});

/** Every reason some test below met, checked whole at the end: none is in the set for nothing. */
const met = new Set<ProbeReason>();
const seen = (result: ProbeResult): ProbeResult => {
  if (!result.ok) met.add(result.reason);
  return result;
};

const stops: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const stop of stops) await stop();
  await cloned.drop();
  await closeIntegrationDatabase();
});

const LETTER = textLetter(
  'ada@example.com',
  'Confirm your address',
  'Open https://purlay.example.com/setup/verify#abc to confirm.',
  'https://purlay.example.com/setup/verify#abc',
);

const USER = 'relay-user@example.com';
const PASS = 'p@ss:w/rd#1 secret';
const urlOf = (port: number, scheme = 'smtp', user = USER, pass = PASS): string =>
  `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@127.0.0.1:${String(port)}`;

const relayFor = async (script: RelayScript): ReturnType<typeof aScriptedRelay> => {
  const relay = await aScriptedRelay(script);
  stops.push(relay.stop);
  return relay;
};

const trySmtp = async (
  smtpUrl: string,
  options: {
    readonly timeoutMs?: number;
    readonly allowPlaintext?: boolean;
    readonly factory?: SmtpTransportFactory;
  } = {},
): Promise<ProbeResult> =>
  seen(
    await probeSmtp(
      AUTHORITY,
      { smtpUrl, from: 'purlay@example.com', allowPlaintext: options.allowPlaintext ?? false },
      LETTER,
      {
        transportFactory: options.factory ?? smtpTransport,
        timeoutMs: options.timeoutMs ?? 5_000,
      },
    ),
  );

const failure = (result: ProbeResult): { reason: ProbeReason; raw: string } => {
  if (result.ok) throw new Error('expected the try to fail');
  return { reason: result.reason, raw: result.raw };
};

describe('integration: trying a relay (D-179 §4.4)', () => {
  test('a relay that takes the login, the sender and the recipient is sent the one letter, as given', async () => {
    const relay = await relayFor({ login: { user: USER, pass: PASS } });
    expect(await trySmtp(urlOf(relay.port))).toEqual({ ok: true });
    expect(relay.received).toHaveLength(1);
    const [received] = relay.received;
    expect(received?.from).toBe('purlay@example.com');
    expect(received?.to).toEqual(['ada@example.com']);
    expect(received?.data).toContain('Subject: Confirm your address');
    expect(received?.data).toContain('https://purlay.example.com/setup/verify#abc');
  });

  test('a port nothing listens on is unreachable', async () => {
    const result = failure(await trySmtp(urlOf(await aClosedPort())));
    expect(result.reason).toBe('unreachable');
    expect(result.raw).toContain('ECONNREFUSED');
  });

  test('a host that does not exist is unreachable', async () => {
    const result = failure(
      await trySmtp(`smtp://${encodeURIComponent(USER)}:x@no-such-relay.invalid:2525`),
    );
    expect(result.reason).toBe('unreachable');
  });

  test('a relay that never greets is unreachable within the bound, not a hang', async () => {
    const relay = await relayFor({ silent: true });
    const started = performance.now();
    const result = failure(await trySmtp(urlOf(relay.port), { timeoutMs: 300 }));
    // A phase is bounded by the whole try's bound when that is shorter (the test below), so here the
    // transport's greeting bound and the probe's own deadline are the same 300 ms and race: either speaks
    // first, about one run in three. Both are the answer — nothing came — so the test holds the reason, the
    // two words the operator may read, and that it did not hang.
    expect(result.reason).toBe('unreachable');
    expect(result.raw).toMatch(/^(no answer within 0\.3 s|ETIMEDOUT: Greeting never received)$/);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('a relay that keeps talking and never finishes is ended by the bound on the whole try', async () => {
    const relay = await relayFor({ dribble: true });
    const started = performance.now();
    const result = failure(await trySmtp(urlOf(relay.port), { timeoutMs: 500 }));
    expect(result.reason).toBe('unreachable');
    expect(performance.now() - started).toBeLessThan(2_500);
  });

  test('each phase is bounded by ten seconds at most, and by the whole try’s bound when it is shorter', async () => {
    const asked: Parameters<SmtpTransportFactory>[0][] = [];
    const recording: SmtpTransportFactory = (options) => {
      asked.push(options);
      return smtpTransport(options);
    };
    const port = await aClosedPort();
    await probeSmtp(
      AUTHORITY,
      { smtpUrl: urlOf(port), from: 'purlay@example.com', allowPlaintext: false },
      LETTER,
      { transportFactory: recording, timeoutMs: SMTP_PROBE_TIMEOUT_MS },
    );
    await probeSmtp(
      AUTHORITY,
      { smtpUrl: urlOf(port), from: 'purlay@example.com', allowPlaintext: false },
      LETTER,
      { transportFactory: recording, timeoutMs: 300 },
    );
    expect(SMTP_PHASE_MS).toBe(10_000);
    expect(SMTP_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
    expect(
      asked.map((options) => [
        options.connectionTimeout,
        options.greetingTimeout,
        options.socketTimeout,
        options.dnsTimeout,
      ]),
    ).toEqual([
      [10_000, 10_000, 10_000, 10_000],
      [300, 300, 300, 300],
    ]);
  });

  test('a relay on this machine whose certificate is not trusted fails TLS when it offers the upgrade', async () => {
    const relay = await relayFor({
      starttls: aSelfSignedCertificate(),
      login: { user: USER, pass: PASS },
    });
    const result = failure(await trySmtp(urlOf(relay.port)));
    expect(result.reason).toBe('tls-failed');
    expect(result.raw).toContain('SELF_SIGNED');
    expect(relay.received).toEqual([]);
  });

  test('smtps:// to a relay that speaks plain SMTP fails TLS', async () => {
    const relay = await relayFor({});
    const result = failure(await trySmtp(urlOf(relay.port, 'smtps')));
    expect(result.reason).toBe('tls-failed');
  });

  test('smtps:// to a relay whose certificate is not trusted fails TLS', async () => {
    const relay = await relayFor({ implicitTls: aSelfSignedCertificate() });
    expect(failure(await trySmtp(urlOf(relay.port, 'smtps'))).reason).toBe('tls-failed');
  });

  test('a relay past this machine that offers no upgrade fails TLS, unless the operator said the link is private', async () => {
    // `relay.example` is past this machine, so the transport must upgrade (`transportOptions`); the
    // factory only points its connection at the relay here, as a DNS record would.
    const elsewhere: SmtpTransportFactory = (options) => {
      expect(options.requireTLS).toBe(true);
      return smtpTransport({ ...options, host: '127.0.0.1' });
    };
    const privately: SmtpTransportFactory = (options) => {
      expect(options.requireTLS).toBe(false);
      return smtpTransport({ ...options, host: '127.0.0.1' });
    };
    const relay = await relayFor({ login: { user: USER, pass: PASS } });
    const address = `smtp://${encodeURIComponent(USER)}:${encodeURIComponent(PASS)}@relay.example:${String(relay.port)}`;
    const refused = failure(await trySmtp(address, { factory: elsewhere }));
    expect(refused).toEqual({ reason: 'tls-failed', raw: '502 5.5.1 STARTTLS not offered' });
    expect(await trySmtp(address, { factory: privately, allowPlaintext: true })).toEqual({
      ok: true,
    });
  });

  test('a wrong password is auth-failed, with the relay’s words', async () => {
    const relay = await relayFor({
      login: { user: USER, pass: 'the right one' },
      loginRefusal: () => '535 5.7.8 Authentication failed',
    });
    expect(failure(await trySmtp(urlOf(relay.port)))).toEqual({
      reason: 'auth-failed',
      raw: '535 5.7.8 Authentication failed',
    });
    expect(relay.received).toEqual([]);
  });

  test('a relay that echoes the login back shows none of it in the reply', async () => {
    const relay = await relayFor({
      login: { user: USER, pass: 'the right one' },
      loginRefusal: ({ user, pass, payload }) =>
        `535 5.7.8 no login ${user}:${pass} payload=${payload} url=smtp://${user}:${pass}@relay`,
    });
    const result = failure(await trySmtp(urlOf(relay.port)));
    expect(result.reason).toBe('auth-failed');
    expect(result.raw.startsWith('535 5.7.8 no login')).toBe(true);
    for (const secret of [
      PASS,
      encodeURIComponent(PASS),
      Buffer.from(PASS).toString('base64'),
      Buffer.from(`\u0000${USER}\u0000${PASS}`).toString('base64'),
      USER,
    ]) {
      expect(result.raw).not.toContain(secret);
    }
    expect(result.raw).not.toContain('secret');
  });

  test('a sender the relay will not send from is sender-refused', async () => {
    const relay = await relayFor({
      login: { user: USER, pass: PASS },
      mailFrom: () => '553 5.7.1 Sender address rejected: not owned by user',
    });
    expect(failure(await trySmtp(urlOf(relay.port)))).toEqual({
      reason: 'sender-refused',
      raw: '553 5.7.1 Sender address rejected: not owned by user',
    });
  });

  test('a recipient the relay will not take is recipient-refused', async () => {
    const relay = await relayFor({
      login: { user: USER, pass: PASS },
      rcptTo: () => '550 5.1.1 Recipient address rejected: unknown',
    });
    expect(failure(await trySmtp(urlOf(relay.port)))).toEqual({
      reason: 'recipient-refused',
      raw: '550 5.1.1 Recipient address rejected: unknown',
    });
  });

  test('a message refused after both addresses were taken is message-refused', async () => {
    const relay = await relayFor({
      login: { user: USER, pass: PASS },
      afterData: '554 5.7.1 Message rejected: DMARC policy',
    });
    expect(failure(await trySmtp(urlOf(relay.port)))).toEqual({
      reason: 'message-refused',
      raw: '554 5.7.1 Message rejected: DMARC policy',
    });
  });

  test('a server that does not greet as SMTP does is an unexpected reply', async () => {
    const relay = await relayFor({ greeting: 'HTTP/1.1 400 Bad Request' });
    expect(failure(await trySmtp(urlOf(relay.port)))).toEqual({
      reason: 'unexpected-reply',
      raw: 'HTTP/1.1 400 Bad Request',
    });
  });

  test('an address no transport can be built from is refused before anything is tried', async () => {
    let thrown: unknown;
    try {
      await trySmtp('smtp://user@relay.example');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('a user and password together, or neither');
  });
});

describe('integration: trying GitHub’s app (D-179 §4.4)', () => {
  const person = aGitHubPerson();
  const tryGitHub = async (
    credentials: { clientId: string; clientSecret: string },
    web: string,
    timeoutMs = 5_000,
  ): Promise<ProbeResult> =>
    seen(
      await probeGitHub(AUTHORITY, credentials, {
        fetch: (url, init) => fetch(url, init),
        githubUrls: { web, api: web },
        timeoutMs,
      }),
    );
  const serve = (handler: (request: Request) => Response | Promise<Response>): string => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
    stops.push(() => void server.stop(true));
    return `http://127.0.0.1:${String(server.port)}`;
  };

  test('a pair GitHub takes is ok: GitHub refused only the code, which it never issued', async () => {
    const stub = aGitHubStub(person);
    const served = stub.serve(0);
    stops.push(served.stop);
    expect(await tryGitHub(GITHUB_STUB_CREDENTIALS, served.url)).toEqual({ ok: true });
    // The token endpoint under the deployment's GitHub, and a code nobody was ever given.
    expect(stub.refusals).toEqual(['bad_verification_code']);
    expect(stub.presentedCodes).toEqual(['purlay-setup-probe-never-issued']);
    expect(GITHUB_PROBE_CODE).toBe('purlay-setup-probe-never-issued');
  });

  test('the probe asks the token endpoint of the GitHub the deployment names, and nothing else', async () => {
    const stub = aGitHubStub(person);
    await probeGitHub(AUTHORITY, GITHUB_STUB_CREDENTIALS, {
      fetch: stub.fetch,
      githubUrls: { web: 'https://github.example.com', api: 'https://api.github.example.com' },
      timeoutMs: 1_000,
    });
    expect(stub.calls.urls).toEqual(['https://github.example.com/login/oauth/access_token']);
    expect(stub.calls.signals).toEqual([true]);
  });

  test('a wrong secret for a known app is secret-rejected, with GitHub’s word', async () => {
    const stub = aGitHubStub(person);
    const served = stub.serve(0);
    stops.push(served.stop);
    expect(
      await tryGitHub(
        { clientId: GITHUB_STUB_CREDENTIALS.clientId, clientSecret: 'stale' },
        served.url,
      ),
    ).toEqual({ ok: false, reason: 'secret-rejected', raw: 'incorrect_client_credentials' });
  });

  test('a client id GitHub does not know is client-unknown', async () => {
    const stub = aGitHubStub(person);
    const served = stub.serve(0);
    stops.push(served.stop);
    expect(
      await tryGitHub({ clientId: 'Iv1.unknown', clientSecret: 'whatever' }, served.url),
    ).toEqual({ ok: false, reason: 'client-unknown', raw: '404 Not Found' });
  });

  test('a GitHub nothing answers at is unreachable', async () => {
    const result = failure(
      await tryGitHub(GITHUB_STUB_CREDENTIALS, `http://127.0.0.1:${String(await aClosedPort())}`),
    );
    expect(result.reason).toBe('unreachable');
    expect(result.raw).toContain('ECONNREFUSED');
  });

  test('a GitHub that never answers is unreachable within the bound — a sign-in’s, ten seconds, in the wizard', async () => {
    expect(GITHUB_PROBE_TIMEOUT_MS).toBe(10_000);
    const web = serve(() => new Promise<Response>(() => undefined));
    const started = performance.now();
    expect(await tryGitHub(GITHUB_STUB_CREDENTIALS, web, 300)).toEqual({
      ok: false,
      reason: 'unreachable',
      raw: 'no answer within 0.3 s',
    });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('a GitHub whose certificate is not trusted fails TLS', async () => {
    const certificate = aSelfSignedCertificate();
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      tls: { cert: certificate.cert, key: certificate.key },
      fetch: () => Response.json({ error: 'bad_verification_code' }),
    });
    stops.push(() => void server.stop(true));
    const result = failure(
      await tryGitHub(GITHUB_STUB_CREDENTIALS, `https://127.0.0.1:${String(server.port)}`),
    );
    expect(result.reason).toBe('tls-failed');
    expect(result.raw).toContain('DEPTH_ZERO_SELF_SIGNED_CERT');
  });

  test('a page that is not GitHub is an unexpected reply, said as it was', async () => {
    const web = serve(() => new Response('<html><body>Welcome to nginx!</body></html>'));
    expect(await tryGitHub(GITHUB_STUB_CREDENTIALS, web)).toEqual({
      ok: false,
      reason: 'unexpected-reply',
      raw: 'HTTP 200: <html><body>Welcome to nginx!</body></html>',
    });
  });

  test('a reply that echoes the secret shows none of it', async () => {
    const secret = 'echoed-secret-0123';
    const web = serve(async (request) =>
      Response.json({ message: 'broken', got: await request.text() }, { status: 500 }),
    );
    const result = failure(
      await tryGitHub({ clientId: GITHUB_STUB_CREDENTIALS.clientId, clientSecret: secret }, web),
    );
    expect(result.reason).toBe('unexpected-reply');
    expect(result.raw.startsWith('HTTP 500:')).toBe(true);
    expect(result.raw).not.toContain(secret);
  });

  test('a token handed back for the never-issued code is an unexpected reply, and the token goes nowhere', async () => {
    // Short enough that nothing token-shaped would catch it: the token is kept out by what it is.
    const token = 'gho_short123';
    const web = serve(() => Response.json({ access_token: token, token_type: 'bearer' }));
    const result = failure(await tryGitHub(GITHUB_STUB_CREDENTIALS, web));
    expect(result).toEqual({
      reason: 'unexpected-reply',
      raw: 'HTTP 200: a token for a code that was never issued',
    });
  });
});

describe('integration: a reply as the operator sees it', () => {
  test('is trimmed, made one line, and cut to 200 characters', () => {
    expect(rawReply('  535 5.7.8\r\n  failed \t ', [])).toBe('535 5.7.8 failed');
    const long = rawReply('x '.repeat(300), []);
    expect(Array.from(long)).toHaveLength(RAW_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  test('carries no credentials of an address and nothing token-shaped', () => {
    expect(rawReply('could not reach smtp://me:hunter2@relay', [])).toBe(
      'could not reach smtp://[redacted]@relay',
    );
    expect(rawReply(`token ${'a'.repeat(40)} given`, [])).toBe('token [redacted] given');
  });

  test('carries no spelling of a secret it was told of', () => {
    const secret = 'pa ss/wörd';
    const said = rawReply(
      `${secret} ${encodeURIComponent(secret)} ${Buffer.from(secret).toString('base64')}`,
      [secret],
    );
    expect(said).toBe('[redacted] [redacted] [redacted]');
  });
});

describe('integration: a GitHub that redirects or floods (review, fix round 1)', () => {
  const tryAt = async (web: string): Promise<ProbeResult> =>
    seen(
      await probeGitHub(
        AUTHORITY,
        { clientId: GITHUB_STUB_CREDENTIALS.clientId, clientSecret: 'S3CRET-redirect' },
        { fetch: (url, init) => fetch(url, init), githubUrls: { web, api: web }, timeoutMs: 5_000 },
      ),
    );

  test('a redirect is not followed: the secret goes nowhere else, and the answer there decides nothing', async () => {
    for (const status of [301, 302, 307, 308] as const) {
      const redirecting = aRedirectingServer(status);
      stops.push(redirecting.stop);
      const result = failure(await tryAt(redirecting.url));
      expect(result.reason).toBe('unexpected-reply');
      expect(result.raw.startsWith(`HTTP ${String(status)}: a redirect`)).toBe(true);
      expect(redirecting.elsewhere).toEqual([]);
    }
  });

  test('a reply that never ends is read no further than 8 KB', async () => {
    const flooding = aFloodingServer(300 * 1024 * 1024);
    stops.push(flooding.stop);
    expect(await tryAt(flooding.url)).toEqual({
      ok: false,
      reason: 'unexpected-reply',
      raw: 'HTTP 200: a reply longer than 8 KB',
    });
    await Bun.sleep(100);
    expect(flooding.written()).toBeLessThan(4 * 1024 * 1024);
  });

  test('a reply whose length says it is too long is not read at all', async () => {
    const flooding = aFloodingServer(300 * 1024 * 1024, { declared: true });
    stops.push(flooding.stop);
    expect(failure(await tryAt(flooding.url)).raw).toBe('HTTP 200: a reply longer than 8 KB');
    await Bun.sleep(100);
    expect(flooding.written()).toBeLessThan(4 * 1024 * 1024);
  });
});

describe('integration: what a relay can do to a probe (review, fix round 1)', () => {
  test('short credentials echoed in every spelling `AUTH` sends them in show none of it', async () => {
    // `\0u\0pw` is `AHUAcHc=` — too short for the token-shaped rule to hide it, and a piece of it is
    // `pw`'s own base64: only the payload's own spelling takes it out whole.
    const relay = await relayFor({
      login: { user: 'u', pass: 'right' },
      loginRefusal: ({ payload }) =>
        `535 5.7.8 p1=${payload} p2=${payload.replace(/=+$/, '')} p3=${Buffer.from('pw').toString('base64').replace(/=+$/, '')}`,
    });
    expect(failure(await trySmtp(urlOf(relay.port, 'smtp', 'u', 'pw')))).toEqual({
      reason: 'auth-failed',
      raw: '535 5.7.8 p1=[redacted] p2=[redacted] p3=[redacted]',
    });
  });

  test('a relay that refuses DATA itself is message-refused', async () => {
    const relay = await relayFor({
      login: { user: USER, pass: PASS },
      dataReply: '554 5.3.4 no data here',
    });
    expect(failure(await trySmtp(urlOf(relay.port)))).toEqual({
      reason: 'message-refused',
      raw: '554 5.3.4 no data here',
    });
  });

  test('a relay past this machine that refuses EHLO, when TLS is required, fails TLS', async () => {
    const relay = await relayFor({ ehloReply: '554 5.7.1 go away' });
    const elsewhere: SmtpTransportFactory = (options) =>
      smtpTransport({ ...options, host: '127.0.0.1' });
    const address = `smtp://${encodeURIComponent(USER)}:x@relay.example:${String(relay.port)}`;
    expect(failure(await trySmtp(address, { factory: elsewhere })).reason).toBe('tls-failed');
  });

  test('a conversation still running at the deadline is cut: the probe leaves no socket open', async () => {
    const relay = await relayFor({ dribble: true });
    failure(await trySmtp(urlOf(relay.port), { timeoutMs: 400 }));
    await Bun.sleep(200);
    expect(relay.openSockets()).toBe(0);
  });

  test('a finished probe leaves no socket open either', async () => {
    const relay = await relayFor({ login: { user: USER, pass: PASS } });
    expect(await trySmtp(urlOf(relay.port))).toEqual({ ok: true });
    await Bun.sleep(100);
    expect(relay.openSockets()).toBe(0);
  });

  test('a sender that is not one plain address is refused before anything is tried', async () => {
    const relay = await relayFor({ login: { user: USER, pass: PASS } });
    for (const from of [
      'purlay@example.com\r\nRCPT TO:<victim@evil.com>',
      'Purlay <purlay@example.com>',
      'purlay@example.com, victim@evil.com',
      '',
    ]) {
      let thrown: unknown;
      try {
        await probeSmtp(
          AUTHORITY,
          { smtpUrl: urlOf(relay.port), from, allowPlaintext: false },
          LETTER,
          { transportFactory: smtpTransport, timeoutMs: 5_000 },
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CandidateRefused);
      expect((thrown as CandidateRefused).field).toBe('from');
    }
    expect(relay.commands).toEqual([]);
  });

  test('a relay whose certificate the server is told to trust (`NODE_EXTRA_CA_CERTS`) is reached', async () => {
    const certificate = aSelfSignedCertificate();
    const relay = await relayFor({ implicitTls: certificate });
    const script = `const { createTransport } = await import('nodemailer');
      try { await createTransport({ host: '127.0.0.1', port: ${String(relay.port)}, secure: true, connectionTimeout: 5000 }).verify(); console.log('verified'); }
      catch (error) { console.log('refused', error.originalCode ?? error.code); }`;
    const run = async (environment: Record<string, string>): Promise<string> => {
      const child = Bun.spawn(['bun', '--no-env-file', '-e', script], {
        cwd: import.meta.dir,
        env: { ...process.env, ...environment },
        stdout: 'pipe',
      });
      return (await new Response(child.stdout).text()).trim();
    };
    expect(await run({ NODE_EXTRA_CA_CERTS: certificate.certFile })).toBe('verified');
    expect(await run({})).toBe('refused DEPTH_ZERO_SELF_SIGNED_CERT');
  });
});

describe('integration: every spelling of a secret (review, fix round 1)', () => {
  test('as typed, escaped in JSON, in an address, in a form, and in base64 with and without its padding', () => {
    const secret = 'a "q\\b+c d';
    const spellings = [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      new URLSearchParams({ s: secret }).toString().slice(2),
      Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('base64').replace(/=+$/, ''),
    ];
    const said = rawReply(spellings.join(' | '), [secret]);
    expect(said).toBe(spellings.map(() => '[redacted]').join(' | '));
  });

  test('a GitHub that echoes its request body back — JSON — shows no secret with a quote or a backslash in it', async () => {
    const secret = 'se"cr\\et';
    const web = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request) => new Response(`echo ${await request.text()}`, { status: 500 }),
    });
    stops.push(() => void web.stop(true));
    const result = failure(
      await probeGitHub(
        AUTHORITY,
        { clientId: 'id', clientSecret: secret },
        {
          fetch: (url, init) => fetch(url, init),
          githubUrls: { web: `http://127.0.0.1:${String(web.port)}`, api: 'x' },
          timeoutMs: 5_000,
        },
      ),
    );
    expect(result.raw).not.toContain('cr\\\\et');
    expect(result.raw).not.toContain('se\\"cr');
  });

  test('control and format characters are one space', () => {
    expect(rawReply('a\u0007b‮c\u0000d', [])).toBe('a b c d');
  });
});

describe('integration: trying a single sign-on provider (D-200 §2, D-179 §4.4)', () => {
  const APP = 'https://purlay.test';

  /** A provider served on a loopback port, and a try of this client at it. */
  const provider = async (
    behaviour: OidcBehaviour = {},
  ): Promise<{ readonly stub: OidcStub; readonly issuer: string }> => {
    const stub = await anOidcStub({ sub: 'a', email: 'a@example.test' }, behaviour);
    const served = stub.serve(0);
    stops.push(served.stop);
    return { stub, issuer: served.url };
  };

  const tryIt = async (
    issuer: string,
    clientSecret: string = OIDC_STUB_CREDENTIALS.clientSecret,
    clientId: string = OIDC_STUB_CREDENTIALS.clientId,
  ): Promise<ProbeResult> =>
    seen(
      await probeOidc(
        AUTHORITY,
        { issuer, clientId, clientSecret },
        {
          fetch: (url, init) => fetch(url, init),
          appUrl: APP,
          log: createLogger({ level: 'silent' }),
        },
      ),
    );

  test('a provider that answers, and takes this client, is ok — and was asked nothing it could act on', async () => {
    const { stub, issuer } = await provider();
    expect(await tryIt(issuer)).toEqual({ ok: true });
    // The code was never issued: the provider could only refuse it, having weighed the client first.
    expect(stub.refusals).toEqual(['invalid_grant']);
    expect(stub.presentedCodes).toEqual([OIDC_PROBE_CODE]);
  });

  test('a secret the provider refuses is secret-rejected, and the reply shows none of it', async () => {
    const { issuer } = await provider();
    const result = failure(await tryIt(issuer, 'S3CRET-sso-wrong'));
    expect(result.reason).toBe('secret-rejected');
    expect(result.raw).not.toContain('S3CRET-sso-wrong');
  });

  test('a client the provider does not know is refused the same way a wrong secret is, as RFC 6749 says', async () => {
    const { issuer } = await provider();
    expect(failure(await tryIt(issuer, OIDC_STUB_CREDENTIALS.clientSecret, 'nobody')).reason).toBe(
      'secret-rejected',
    );
  });

  test.each<[string, OidcBehaviour, ProbeReason]>([
    ['another issuer in its document', { discovery: 'issuer-mismatch' }, 'issuer-mismatch'],
    ['no PKCE with S256', { discovery: 'no-pkce' }, 'discovery-invalid'],
    ['a signing algorithm no one verifies', { discovery: 'hmac-only' }, 'discovery-invalid'],
    ['a discovery document that is a 503', { discovery: 'refuses' }, 'discovery-invalid'],
    ['keys that are not keys', { jwks: 'garbage' }, 'unexpected-reply'],
    ['a token endpoint that is down', { token: 'refuses' }, 'unexpected-reply'],
  ])('%s is %s', async (_what, behaviour, reason) => {
    const { issuer } = await provider(behaviour);
    expect(failure(await tryIt(issuer)).reason).toBe(reason);
  });

  test('a provider nothing answers for is unreachable', async () => {
    const closed = await aClosedPort();
    const result = failure(await tryIt(`http://127.0.0.1:${String(closed)}`));
    expect(result.reason).toBe('unreachable');
  });

  test('a provider whose certificate is not trusted is tls-failed, and its client secret was never sent', async () => {
    const certificate = aSelfSignedCertificate();
    const received: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      tls: { cert: certificate.cert, key: certificate.key },
      fetch: (request) => {
        received.push(request.url);
        return Response.json({});
      },
    });
    stops.push(() => server.stop(true));
    const result = failure(await tryIt(`https://127.0.0.1:${String(server.port)}`));
    expect(result.reason).toBe('tls-failed');
    expect(received).toEqual([]);
  });

  test('a redirect is not followed at discovery: the secret goes nowhere else, and the answer there decides nothing', async () => {
    for (const status of [301, 302, 307, 308] as const) {
      const redirecting = aRedirectingServer(status);
      stops.push(redirecting.stop);
      expect(failure(await tryIt(redirecting.url)).reason).toBe('discovery-invalid');
      expect(redirecting.elsewhere).toEqual([]);
    }
  });

  test('a document that never ends is read no further than 256 KB, and is not a provider', async () => {
    const flooding = aFloodingServer(300 * 1024 * 1024);
    stops.push(flooding.stop);
    expect(failure(await tryIt(flooding.url)).reason).toBe('discovery-invalid');
    await Bun.sleep(100);
    expect(flooding.written()).toBeLessThan(8 * 1024 * 1024);
  });

  test('a token endpoint that redirects the secret elsewhere is unexpected-reply, and the secret goes nowhere', async () => {
    const { issuer } = await provider({ token: 'redirects' });
    expect(failure(await tryIt(issuer)).reason).toBe('unexpected-reply');
  });

  test('the reply shown is the provider’s own words, with the secret taken out of every spelling', async () => {
    const hostile = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        const base = new URL(request.url).origin;
        if (pathname === '/.well-known/openid-configuration') {
          return Response.json({
            issuer: base,
            authorization_endpoint: `${base}/a`,
            token_endpoint: `${base}/token`,
            jwks_uri: `${base}/jwks`,
          });
        }
        if (pathname === '/jwks') return Response.json({ keys: [] });
        return Response.json(
          { error: 'S3CRET-echoed', error_description: 'S3CRET-echoed' },
          { status: 418 },
        );
      },
    });
    stops.push(() => hostile.stop(true));
    const result = failure(
      await tryIt(`http://127.0.0.1:${String(hostile.port)}`, 'S3CRET-echoed'),
    );
    expect(result.reason).toBe('unexpected-reply');
    expect(result.raw).not.toContain('S3CRET-echoed');
  });
});

describe('integration: the reasons', () => {
  test('every reason in the closed set is one a probe above produced', () => {
    expect([...met].sort()).toEqual([...PROBE_REASONS].sort());
  });
});
