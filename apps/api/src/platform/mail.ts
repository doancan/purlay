/**
 * Sending mail: sign-in links (#81, D-138 §6) and invitations (D-179 §5), over SMTP with nodemailer (`docs/spikes/nodemailer.md`).
 *
 * - **The transport is built from an object, typed** — the spike's first run passed its options where
 *   the library reads a message's defaults, and nothing said so. `transportOptions` is what is built,
 *   a function of the configuration, tested without a network.
 * - **TLS past this machine.** Every message carries a sign-in link, a bearer token: `smtps://` is TLS
 *   from the start, and `smtp://` to a relay that is not on this machine must upgrade with STARTTLS —
 *   a relay that does not offer it fails the send — unless the operator said the link is private.
 * - **Sent after the answer, waited for on shutdown.** The outbox starts a send and returns: how long a
 *   relay takes says nothing to whoever asked (D-138 §6). A send that fails is logged — never with its
 *   address or its words (ARCHITECTURE §10) — and `flush` waits for the ones on their way, within a
 *   bound that fits inside the shutdown's own; a send still out past it is said, by count.
 * - **Said at start whether the relay answers.** A wrong password or a relay that cannot upgrade would
 *   otherwise show only as each send failing, after a `202` to somebody waiting for a link.
 * - **One recipient, said to the relay.** The envelope names the address itself, never what a mail
 *   library would read out of a header.
 */
import { createTransport } from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { Config } from './config';
import type { Logger } from './logging';

/** One message: to one address, in plain text and HTML. */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Hands a message to the relay; resolves once it has accepted it. */
export type SendMail = (message: MailMessage) => Promise<void>;

/** A relay, and whether it answers: connected, greeted, upgraded and signed in to. */
export interface Mailer {
  readonly send: SendMail;
  readonly verify: () => Promise<void>;
  /**
   * Lets the transport go, once its letters are out: what a relay replaced by a change of the settings
   * is told (`modules/setup/runtime.ts`). Nodemailer's unpooled transport holds no connection between
   * letters — each opens its own and closes it — so a letter posted after this is still sent.
   */
  readonly close: () => void;
}

/** How long a relay may take, connecting and answering, before a send is given up. */
const CONNECT_MS = 10_000;
const SOCKET_MS = 20_000;

/** A relay on this machine: what a plaintext link to it crosses is nothing. */
const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** What the transport is built from, for an `smtp://` or `smtps://` address. */
export const transportOptions = (
  config: Pick<Config, 'SMTP_ALLOW_PLAINTEXT'> & { readonly SMTP_URL: string },
): SMTPTransport.Options => {
  const url = new URL(config.SMTP_URL);
  const secure = url.protocol === 'smtps:';
  const user = decodeURIComponent(url.username);
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port === '' ? (secure ? 465 : 587) : Number(url.port),
    secure,
    // Past this machine, the upgrade is required: a relay without it fails the send, loudly.
    requireTLS: !secure && !LOOPBACK.has(url.hostname) && !config.SMTP_ALLOW_PLAINTEXT,
    ...(user === '' ? {} : { auth: { user, pass: decodeURIComponent(url.password) } }),
    connectionTimeout: CONNECT_MS,
    greetingTimeout: CONNECT_MS,
    socketTimeout: SOCKET_MS,
    // Unpooled, on purpose: a connection per letter, so `close` holds nothing back and a letter posted
    // to a relay the settings replaced after it was closed is still sent (`mail.test.ts` pins it).
  };
};

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A letter in plain text and the same as HTML, with `url` — which must appear in `text` — made a link.
 * Every character of the text is escaped for the HTML, so what a name says stays words.
 */
export const textLetter = (
  to: string,
  subject: string,
  text: string,
  url: string,
): MailMessage => ({
  to,
  subject,
  text,
  html: `<p>${escapeHtml(text)
    .replace(escapeHtml(url), `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`)
    .replace(/\n\n/g, '</p><p>')}</p>`,
});

/** What the relay is handed: the envelope names the one recipient, not a header parsed for one. */
export const letter = (message: MailMessage, from: string): Mail.Options => ({
  from,
  ...message,
  envelope: { from, to: [message.to] },
});

/** What asking a relay takes of a transport: whether it answers, one letter, and letting it go. */
interface SmtpTransport {
  readonly verify: () => Promise<true>;
  readonly sendMail: (mail: Mail.Options) => Promise<SMTPTransport.SentMessageInfo>;
  readonly close: () => void;
}

/** Builds a transport from its options: nodemailer's, or a test's around it. */
export type SmtpTransportFactory = (options: SMTPTransport.Options) => SmtpTransport;

/** Nodemailer's transport, the one every relay is spoken to through. */
export const smtpTransport: SmtpTransportFactory = (options) => createTransport(options);

/** The relay this server is configured with, sending from `MAIL_FROM`. */
export const smtpMailer = (
  config: Pick<Config, 'SMTP_ALLOW_PLAINTEXT'> & {
    readonly SMTP_URL: string;
    readonly MAIL_FROM: string;
  },
): Mailer => {
  const transport = createTransport(transportOptions(config));
  return {
    send: async (message): Promise<void> => {
      await transport.sendMail(letter(message, config.MAIL_FROM));
    },
    verify: async (): Promise<void> => {
      await transport.verify();
    },
    close: (): void => {
      transport.close();
    },
  };
};

/** How long `flush` waits for sends in flight when the process is ending. */
const FLUSH_BOUND_MS = 2_000;

/** A relay's error code, `EENVELOPE` and its like; nothing else of the error. */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
};

/**
 * Whether the relay answers, said once as the server starts. Not a refusal to start: a relay down for
 * a minute is not a reason to take the chat down with it, and each send that fails says so too.
 */
export const checkRelay = async (mailer: Mailer, log: Logger): Promise<void> => {
  try {
    await mailer.verify();
    log.info('mail relay answers');
  } catch (error) {
    log.error('mail relay does not answer: email sign-in links will not arrive', {
      reason: codeOf(error),
    });
  }
};

export interface Outbox {
  /** Starts sending, and returns: the answer to whoever asked does not wait for the relay. */
  readonly post: (message: MailMessage, purpose: string) => void;
  /**
   * Resolves when every send started so far has finished, or the bound has passed — and then says
   * `left`, with how many are still on their way.
   */
  readonly flush: (boundMs?: number, left?: string) => Promise<void>;
}

/**
 * Waits for the sends in `running` — those started while it waits too — or until the bound has passed,
 * and says how many were left. Never throws: each send has said its own failure already.
 */
const flushRunning = async (
  running: ReadonlySet<Promise<void>>,
  log: Logger,
  boundMs: number,
  left: string,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<'bound'>((resolve) => {
    timer = setTimeout(() => {
      resolve('bound');
    }, boundMs);
  });
  const drained = (async (): Promise<'drained'> => {
    while (running.size > 0) await Promise.allSettled([...running]);
    return 'drained';
  })();
  const outcome = await Promise.race([drained, bound]);
  clearTimeout(timer);
  // Each of these was answered `202`: the person will ask again, and the log says how many will.
  if (outcome === 'bound') log.warn(left, { sending: running.size });
};

/** What a flush that ran out of time says, by default: the process is ending without them. */
const LEFT_AT_SHUTDOWN = 'mail left at shutdown';

/**
 * Every send started by any outbox that shares it, whichever relay it went through: what a shutdown
 * waits for when the settings have replaced the relay since the start, so a letter posted to the one
 * replaced — even after it was let go — is waited for as the current one's are.
 */
export interface MailInFlight {
  /** Resolves when every send started so far by every outbox sharing this has finished, or the bound passed. */
  readonly flush: (boundMs?: number) => Promise<void>;
  /** The set the outboxes add to; theirs to write, nobody else's. */
  readonly running: Set<Promise<void>>;
}

export const mailInFlight = (log: Logger): MailInFlight => {
  const running = new Set<Promise<void>>();
  return {
    running,
    flush: async (boundMs = FLUSH_BOUND_MS): Promise<void> => {
      await flushRunning(running, log, boundMs, LEFT_AT_SHUTDOWN);
    },
  };
};

export const outbox = (send: SendMail, log: Logger, shared?: MailInFlight): Outbox => {
  const running = new Set<Promise<void>>();
  return {
    post: (message, purpose): void => {
      const sending: Promise<void> = send(message)
        .then(() => {
          log.info('mail sent', { purpose });
        })
        // Not the caller's to know: they were answered already, the same whatever happened. Said
        // here, by what it was for — never to whom, never what it said.
        .catch((error: unknown) => {
          // The relay's code only: its words can quote the recipient back.
          log.error('mail could not be sent', {
            purpose,
            reason: codeOf(error),
          });
        })
        .finally(() => {
          running.delete(sending);
          shared?.running.delete(sending);
        });
      running.add(sending);
      shared?.running.add(sending);
    },
    flush: async (boundMs = FLUSH_BOUND_MS, left = LEFT_AT_SHUTDOWN): Promise<void> => {
      await flushRunning(running, log, boundMs, left);
    },
  };
};
