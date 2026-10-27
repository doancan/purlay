/**
 * Trying GitHub's app and a mail relay before either is saved (D-179 §4.4, Ruling R47): each probe
 * calls the service for real with the **candidate** values — nothing here reads or writes the settings
 * — and answers `ProbeResult`, one of the closed set of reasons with the service's own reply.
 *
 * - **GitHub**: the token endpoint (`GITHUB_URL`, the base every sign-in uses) is sent the client id
 *   and secret with a code that is **never one GitHub issued** (`GITHUB_PROBE_CODE`). GitHub weighs the
 *   app before the code: `bad_verification_code` says the pair is good and only the code is not;
 *   `incorrect_client_credentials` is a known app with the wrong secret; an app it does not know is
 *   `404 {"error":"Not Found"}` (measured on github.com, 2026-10-22; the documentation lists only the
 *   first two). No `redirect_uri` is sent — the parameter is optional, and a mismatch is decided on
 *   GitHub's authorize screen, which no probe reaches — so the callback address is shown for pasting
 *   rather than tried. A token, should anything hand one back for that code, is not kept or shown: it
 *   is a reply no GitHub gives (`unexpected-reply`).
 * - **Mail**: a transport built from the candidate address as every relay's is (`transportOptions`:
 *   TLS past this machine), asked whether it answers (`verify`: connection, TLS, login) and then handed
 *   **one** letter, the caller's — in the wizard, the administrator's own verification letter. Each
 *   phase is bounded (`SMTP_PHASE_MS`) and so is the whole (`timeoutMs`); nothing is retried.
 * - **The reply is the operator's to read, never a credential** (`rawReply`): trimmed, at most 200
 *   characters, with every spelling of what was tried — as typed, escaped, in base64 as `AUTH` sends it —
 *   and anything token-shaped taken out, so a relay that echoes a login back shows none of it.
 *
 * **Where the relay is, is the claim holder's to say.** The probe connects to whatever host the
 * candidate names, internal relays included — the setup is done by whoever runs the server (they read
 * the code from its log), only while it is open, and only under the claim (the endpoint's to require).
 */
import net from 'node:net';
import {
  normalisedMailbox,
  OIDC_CALLBACK,
  type ProbeReason,
  type ProbeResult,
} from '@purlay/types';
import {
  letter,
  transportOptions,
  type MailMessage,
  type SmtpTransportFactory,
} from '../../platform/mail';
import { systemClock } from '../../platform/clock';
import { readCapped } from '../../platform/http-body';
import type { Logger } from '../../platform/logging';
import { smtpUrlProblem } from '../../platform/smtp-address';
import { githubEndpoints, type GithubFetch, type GitHubUrls } from '../auth/better-auth';
import {
  createOidcProvider,
  OidcDiscoveryError,
  tokenRequest,
  type Discovery,
  type OidcCredentials,
  type OidcFetch,
} from '../auth/oidc';
import type { SmtpSettings } from './settings';
import type { ServerAdminSession, SetupSession } from './setup';

/**
 * Who may run a probe (Ruling R48): the browser holding the setup's claim, or — with Administration →
 * Server — a signed-in server administrator. A probe checks nothing against the database itself, so it
 * takes the proof as its first argument: each kind is minted by its guard alone, and a route that did
 * not pass one cannot call it.
 */
export type ProbeAuthority = SetupSession | ServerAdminSession;

/** The code every GitHub probe sends: never issued, so GitHub can only refuse it. */
export const GITHUB_PROBE_CODE = 'purlay-setup-probe-never-issued';

/** How long GitHub may take to answer a probe: as long as it may take in a sign-in. */
export const GITHUB_PROBE_TIMEOUT_MS = 10_000;

/** How long a mail probe may take, whole. */
export const SMTP_PROBE_TIMEOUT_MS = 20_000;

/** How long any one phase of it may — DNS and connecting, the greeting and TLS, a silence. */
export const SMTP_PHASE_MS = 10_000;

/** The longest reply shown. */
export const RAW_MAX = 200;

/** The most of GitHub's reply a probe reads: its answer to a token request is a few hundred bytes. */
const GITHUB_PROBE_REPLY_MAX_BYTES = 8 * 1024;

const REDACTED = '[redacted]';

/** Anything a token could be: a run of 32 or more characters of the alphabets tokens are written in. */
const TOKEN_SHAPED = /[A-Za-z0-9+/=_-]{32,}/g;

/** The credentials of an address written into it: `scheme://user:password@`. */
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi;

/** A system or library code that says a secure connection failed, as Bun and nodemailer name them. */
const TLS_CODE =
  /^(?:ETLS|ERR_SSL_|ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|HOSTNAME_MISMATCH$)/;

const isTlsCode = (code: string | undefined): boolean => code !== undefined && TLS_CODE.test(code);

/**
 * A reply as the operator may see it: every spelling of each secret replaced, an address's credentials
 * and anything token-shaped taken out, controls and runs of space made one space, trimmed, and cut to
 * `RAW_MAX` characters.
 */
export const rawReply = (reply: string, secrets: readonly string[]): string => {
  const spellings = secrets
    .filter((secret) => secret !== '')
    .flatMap((secret) => {
      const base64 = Buffer.from(secret, 'utf8').toString('base64');
      return [
        secret,
        // Inside a JSON string — the probe's own request body, echoed back.
        JSON.stringify(secret).slice(1, -1),
        encodeURIComponent(secret),
        // In a form body: a space is `+`.
        new URLSearchParams({ s: secret }).toString().slice(2),
        base64,
        // Without its padding, as a short credential is often quoted.
        base64.replace(/=+$/, ''),
      ];
    })
    // The longest first, so no shorter spelling leaves a piece of a longer one behind.
    .sort((left, right) => right.length - left.length);
  let text = reply;
  for (const spelling of spellings) text = text.split(spelling).join(REDACTED);
  text = text
    .replace(USERINFO, `$1${REDACTED}@`)
    .replace(TOKEN_SHAPED, REDACTED)
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
    .trim();
  const characters = Array.from(text);
  return characters.length > RAW_MAX ? `${characters.slice(0, RAW_MAX - 1).join('')}…` : text;
};

/** A candidate the probe will not try: the route's to refuse as input before it calls (`field`). */
export class CandidateRefused extends Error {
  readonly field: 'smtpUrl' | 'from';

  constructor(field: 'smtpUrl' | 'from', problem: string) {
    super(`the ${field === 'from' ? 'sender' : 'relay address'} cannot be tried: ${problem}`);
    this.name = 'CandidateRefused';
    this.field = field;
  }
}

const failed = (reason: ProbeReason, raw: string): ProbeResult => ({ ok: false, reason, raw });

/** What an error says of itself, by the fields Bun's `fetch` and nodemailer give it. */
interface ErrorFields {
  readonly name: string | undefined;
  readonly code: string | undefined;
  readonly originalCode: string | undefined;
  readonly command: string | undefined;
  readonly response: string | undefined;
  readonly message: string;
}

const fieldsOf = (error: unknown): ErrorFields => {
  const record = (typeof error === 'object' && error !== null ? error : {}) as Readonly<
    Record<string, unknown>
  >;
  const text = (key: string): string | undefined =>
    typeof record[key] === 'string' ? record[key] : undefined;
  return {
    name: text('name'),
    code: text('code'),
    originalCode: text('originalCode'),
    command: text('command'),
    response: text('response'),
    message: text('message') ?? String(error),
  };
};

const seconds = (ms: number): string => `${String(Math.round(ms / 100) / 10)} s`;

export interface GitHubProbeDependencies {
  readonly fetch: GithubFetch;
  /** The deployment's GitHub (`GITHUB_URL`, `GITHUB_API_URL`): the bases a sign-in uses. */
  readonly githubUrls: GitHubUrls;
  readonly timeoutMs: number;
}

/** GitHub's own answer to a token request, read as it says it. */
const githubVerdict = (status: number, text: string, secret: string): ProbeResult => {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const record = (typeof body === 'object' && body !== null ? body : {}) as Readonly<
    Record<string, unknown>
  >;
  const error = typeof record['error'] === 'string' ? record['error'] : undefined;
  // The app is known and its secret right: only the code — never issued — was refused.
  if (status === 200 && error === 'bad_verification_code') return { ok: true };
  if (status === 200 && error === 'incorrect_client_credentials') {
    return failed('secret-rejected', rawReply(error, [secret]));
  }
  if (status === 404 && error === 'Not Found') return failed('client-unknown', '404 Not Found');
  if ('access_token' in record) {
    // A token for a code nobody was given is no GitHub's answer; the token itself goes nowhere.
    return failed(
      'unexpected-reply',
      `HTTP ${String(status)}: a token for a code that was never issued`,
    );
  }
  return failed('unexpected-reply', rawReply(`HTTP ${String(status)}: ${text}`, [secret]));
};

/** Whether GitHub takes this client id and secret together. Sends no code GitHub ever issued. */
export const probeGitHub = async (
  _authority: ProbeAuthority,
  credentials: { readonly clientId: string; readonly clientSecret: string },
  { fetch, githubUrls, timeoutMs }: GitHubProbeDependencies,
): Promise<ProbeResult> => {
  try {
    const response = await fetch(githubEndpoints(githubUrls).token, {
      method: 'POST',
      headers: {
        'User-Agent': 'purlay',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code: GITHUB_PROBE_CODE,
      }),
      // Never followed: a 307 or 308 would re-send the secret to wherever it points (review).
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location') ?? 'nowhere';
      return failed(
        'unexpected-reply',
        rawReply(`HTTP ${String(response.status)}: a redirect to ${location}, not followed`, [
          credentials.clientSecret,
        ]),
      );
    }
    // Read under the same deadline, and no further than a reply needs: a body that never ends is no
    // answer either.
    const body = await readCapped(response, GITHUB_PROBE_REPLY_MAX_BYTES);
    if ('tooLarge' in body) {
      return failed(
        'unexpected-reply',
        `HTTP ${String(response.status)}: a reply longer than ${String(GITHUB_PROBE_REPLY_MAX_BYTES / 1024)} KB`,
      );
    }
    return githubVerdict(response.status, body.text, credentials.clientSecret);
  } catch (error) {
    const { name, code, message } = fieldsOf(error);
    if (name === 'TimeoutError' || name === 'AbortError') {
      return failed('unreachable', `no answer within ${seconds(timeoutMs)}`);
    }
    const said = rawReply(`${code ?? name ?? 'Error'}: ${message}`, [credentials.clientSecret]);
    return failed(isTlsCode(code) ? 'tls-failed' : 'unreachable', said);
  }
};

export interface OidcProbeDependencies {
  /** The platform's own `fetch`, never following a redirect (the type requires it). */
  readonly fetch: OidcFetch;
  /** `APP_URL`: the callback address the provider is sent with the code it is tried with. */
  readonly appUrl: string;
  /** Where what a try meets is said, as a sign-in says it; the reply shown to the operator is the probe's own. */
  readonly log: Logger;
}

/** The code every provider probe sends: never issued, so the provider can only refuse it. */
export const OIDC_PROBE_CODE = 'purlay-probe-code-never-issued';

/**
 * Whether the provider is one this server can sign in through, and takes this client (D-200 §2, D-179 §4.4).
 * Three calls, each bounded (`OIDC_TIMEOUT_MS`) and none followed through a redirect: its discovery document,
 * checked as a sign-in checks it (`discover` — the issuer it names is the one given, every endpoint secure,
 * the code flow with S256 offered); its key set; and the token endpoint, sent this client's credentials with a
 * code nobody was ever given. A provider weighs the client before the code: `invalid_grant` says the pair is
 * good and only the code is not; `invalid_client` is a refused secret. Nothing is kept of what it answers.
 */
export const probeOidc = async (
  _authority: ProbeAuthority,
  credentials: OidcCredentials,
  { fetch, appUrl, log }: OidcProbeDependencies,
): Promise<ProbeResult> => {
  const secrets = [credentials.clientSecret];
  const said = (error: unknown): string => {
    const { code, name, message } = fieldsOf(error);
    return rawReply(`${code ?? name ?? 'Error'}: ${message}`, secrets);
  };
  let metadata: Discovery;
  try {
    const provider = createOidcProvider(credentials, 'probe', {
      fetch,
      clock: systemClock,
      log,
      onIdentity: (): void => undefined,
    });
    metadata = await provider.check();
  } catch (error) {
    if (error instanceof OidcDiscoveryError) {
      const { code } = fieldsOf(error.cause);
      if (error.reason === 'unreachable') {
        return failed(isTlsCode(code) ? 'tls-failed' : 'unreachable', said(error.cause ?? error));
      }
      return failed(error.reason, rawReply(error.message, secrets));
    }
    return failed('unreachable', said(error));
  }
  let answer: { readonly status: number; readonly json: unknown };
  try {
    answer = await tokenRequest(
      metadata,
      credentials,
      {
        code: OIDC_PROBE_CODE,
        codeVerifier: 'purlay-probe-verifier-purlay-probe-verifier-purlay',
        redirectURI: `${appUrl}${OIDC_CALLBACK}`,
      },
      fetch,
    );
  } catch (error) {
    const { code } = fieldsOf(error instanceof OidcDiscoveryError ? error.cause : error);
    return failed(
      isTlsCode(code) ? 'tls-failed' : 'unreachable',
      said(error instanceof OidcDiscoveryError ? (error.cause ?? error) : error),
    );
  }
  const body = typeof answer.json === 'object' && answer.json !== null ? answer.json : {};
  const said_ = (body as Readonly<Record<string, unknown>>)['error'];
  const error = typeof said_ === 'string' ? said_ : undefined;
  if (answer.status === 400 && error === 'invalid_grant') return { ok: true };
  if (error === 'invalid_client' || answer.status === 401) {
    return failed(
      'secret-rejected',
      rawReply(`HTTP ${String(answer.status)}: ${error ?? ''}`, secrets),
    );
  }
  if (error === 'unauthorized_client') {
    return failed(
      'client-unknown',
      rawReply(`HTTP ${String(answer.status)}: unauthorized_client`, secrets),
    );
  }
  // A token for a code nobody was given is no provider's answer; it goes nowhere.
  return failed(
    'unexpected-reply',
    rawReply(`HTTP ${String(answer.status)}: ${error ?? 'not an OAuth error'}`, secrets),
  );
};

/** Why nodemailer gave up, as one of the reasons; anything it does not name is `unexpected-reply`. */
const smtpReason = ({ code, originalCode, command, message }: ErrorFields): ProbeReason => {
  if (isTlsCode(code) || isTlsCode(originalCode)) return 'tls-failed';
  if (code === 'EAUTH' || code === 'ENOAUTH') return 'auth-failed';
  if (code === 'EENVELOPE') {
    if (command === 'MAIL FROM' || /\bsender\b/i.test(message)) return 'sender-refused';
    if (command === 'RCPT TO' || /\brecipient/i.test(message)) return 'recipient-refused';
    return 'message-refused';
  }
  if (code === 'EMESSAGE') return 'message-refused';
  // An upgrade a relay past this machine must make, and does not offer: a TLS failure, not a silence.
  if (code === 'ECONNECTION' && message.includes('STARTTLS')) return 'tls-failed';
  if (code === 'EDNS' || code === 'ESOCKET' || code === 'ECONNECTION' || code === 'ETIMEDOUT') {
    return 'unreachable';
  }
  return 'unexpected-reply';
};

/** Every spelling of the credentials an address carries, for `rawReply` to take out. */
const credentialsOf = (smtpUrl: string): string[] => {
  const url = new URL(smtpUrl);
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  // `AUTH PLAIN` sends both in one base64 payload, which `rawReply` spells for each secret given.
  return [smtpUrl, url.username, url.password, user, pass, `\u0000${user}\u0000${pass}`];
};

/**
 * Why a relay's candidate settings cannot be tried, or nothing: the address as the transport would
 * parse it — and no space or line break anywhere in it, which the URL parser would quietly drop — and
 * the sender one plain address, as the settings store it: no name, nothing a header or an envelope is
 * made of. Asked by `probeSmtp`, and by the endpoint before it makes a letter to try with.
 */
export const candidateRefusal = (
  settings: Pick<SmtpSettings, 'smtpUrl' | 'from'>,
): CandidateRefused | undefined => {
  if (/\s/.test(settings.smtpUrl)) {
    return new CandidateRefused('smtpUrl', 'an address with no space or line break in it');
  }
  const problem = smtpUrlProblem(settings.smtpUrl);
  if (problem !== undefined) return new CandidateRefused('smtpUrl', problem);
  if (normalisedMailbox(settings.from) === undefined || /[\r\n]/.test(settings.from)) {
    return new CandidateRefused('from', 'one plain address, with no name and nothing else');
  }
  return undefined;
};

export interface SmtpProbeDependencies {
  /** Nodemailer's (`smtpTransport`), or a test's around it. */
  readonly transportFactory: SmtpTransportFactory;
  /** The bound on the whole probe; each phase is bounded by the smaller of this and `SMTP_PHASE_MS`. */
  readonly timeoutMs: number;
}

/**
 * Whether the relay the candidate settings name answers, takes their login, and accepts `message` from
 * their sender. Builds a transport of its own from them; the settings stored are not read or changed.
 * An address no transport can be built from is the caller's to refuse first (`smtpUrlProblem`): it is
 * thrown here, never tried.
 */
export const probeSmtp = async (
  _authority: ProbeAuthority,
  settings: SmtpSettings,
  message: MailMessage,
  { transportFactory, timeoutMs }: SmtpProbeDependencies,
): Promise<ProbeResult> => {
  const refused = candidateRefusal(settings);
  if (refused !== undefined) throw refused;
  const from = normalisedMailbox(settings.from) ?? settings.from;
  const phase = Math.min(timeoutMs, SMTP_PHASE_MS);
  // The probe opens the sockets itself and hands them to the transport: nodemailer's `close()` lets go
  // of none (10.1.2, read), and a `getSocket` answer is used only as an opened `connection` — so what
  // is still talking at the deadline is cut here, by the probe that opened it.
  const sockets = new Set<net.Socket>();
  const transport = transportFactory({
    ...transportOptions({
      SMTP_URL: settings.smtpUrl,
      SMTP_ALLOW_PLAINTEXT: settings.allowPlaintext,
    }),
    connectionTimeout: phase,
    greetingTimeout: phase,
    socketTimeout: phase,
    dnsTimeout: phase,
    getSocket: (options, give) => {
      const socket = net.connect({ host: options.host ?? '', port: Number(options.port ?? 0) });
      // The transport listens from the next line on; this only keeps a late error off the process.
      socket.on('error', () => undefined);
      sockets.add(socket);
      give(null, { connection: socket });
    },
  });
  const secrets = credentialsOf(settings.smtpUrl);
  const trying = (async (): Promise<ProbeResult> => {
    try {
      await transport.verify();
      await transport.sendMail(letter(message, from));
      return { ok: true };
    } catch (error) {
      const fields = fieldsOf(error);
      const said =
        fields.response ?? `${fields.originalCode ?? fields.code ?? 'Error'}: ${fields.message}`;
      return failed(smtpReason(fields), rawReply(said, secrets));
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => {
      resolve(failed('unreachable', `no answer within ${seconds(timeoutMs)}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([trying, deadline]);
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
  }
};
