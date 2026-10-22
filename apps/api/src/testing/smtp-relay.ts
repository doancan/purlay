/**
 * A mail relay on this machine that speaks as much SMTP as a probe meets — the greeting, `EHLO` with or
 * without `STARTTLS` and `AUTH`, `AUTH PLAIN` and `AUTH LOGIN`, `MAIL FROM`, `RCPT TO`, `DATA`, `QUIT` —
 * and answers each the way a script says: so every way a real relay refuses can be met by the real
 * transport, over a real socket, TLS included. Test-only; `relay.ts` is the smaller one that only
 * accepts.
 */
import net from 'node:net';
import tls from 'node:tls';
import type { Certificate } from './certificate';

/** What was tried at `AUTH`: the user and password the relay was sent, and the payload they came in. */
interface LoginTried {
  readonly user: string;
  readonly pass: string;
  readonly payload: string;
}

export interface RelayScript {
  /** The first line the relay sends. A relay that greets with something else is not SMTP. */
  readonly greeting?: string;
  /** Accepts the connection and never says a word. */
  readonly silent?: boolean;
  /**
   * Answers `EHLO` with a line every 50 ms and never the last: never silent long enough for a socket's
   * idle timeout, and never done — what only a bound on the whole conversation ends.
   */
  readonly dribble?: boolean;
  /** TLS from the first byte (`smtps://`), with this certificate. */
  readonly implicitTls?: Certificate;
  /** Offers `STARTTLS` and upgrades with this certificate. */
  readonly starttls?: Certificate;
  /** Offers `AUTH PLAIN LOGIN` and takes these credentials alone. */
  readonly login?: { readonly user: string; readonly pass: string };
  /** The answer to any other login. */
  readonly loginRefusal?: (tried: LoginTried) => string;
  readonly mailFrom?: (address: string) => string;
  readonly rcptTo?: (address: string) => string;
  /** The answer once the message's final dot is in. */
  readonly afterData?: string;
  /** The answer to `DATA` itself, instead of going ahead. */
  readonly dataReply?: string;
  /** The answer to `EHLO`, instead of the extensions. */
  readonly ehloReply?: string;
}

interface Received {
  readonly from: string;
  readonly to: readonly string[];
  readonly data: string;
}

export interface ScriptedRelay {
  readonly port: number;
  /** Every command line, in order, `AUTH` payloads included. */
  readonly commands: string[];
  /** Every message accepted. */
  readonly received: Received[];
  /** How many connections are open now. */
  readonly openSockets: () => number;
  readonly stop: () => Promise<void>;
}

const OK = '250 2.0.0 ok';

/** One conversation, over whichever socket it is on now: plain first, TLS after `STARTTLS`. */
const converse = (
  first: net.Socket,
  script: RelayScript,
  relay: { readonly commands: string[]; readonly received: Received[] },
): void => {
  let socket: net.Socket = first;
  let buffered = '';
  let secure = script.implicitTls !== undefined;
  let signedIn = false;
  let awaiting: 'nothing' | 'plain' | 'login-user' | 'login-pass' | 'data' = 'nothing';
  let loginUser = '';
  let envelope: { from: string; to: string[] } = { from: '', to: [] };
  let data: string[] = [];

  const say = (line: string): void => {
    socket.write(`${line}\r\n`);
  };
  const decoded = (text: string): string => Buffer.from(text, 'base64').toString('utf8');
  const weigh = (user: string, pass: string, payload: string): void => {
    if (user === script.login?.user && pass === script.login.pass) {
      signedIn = true;
      say('235 2.7.0 Authentication successful');
      return;
    }
    say(
      script.loginRefusal?.({ user, pass, payload }) ??
        '535 5.7.8 Authentication credentials invalid',
    );
  };
  const addressIn = (line: string): string => /<([^>]*)>/.exec(line)?.[1] ?? '';

  const line = (text: string): void => {
    relay.commands.push(text);
    if (awaiting === 'data') {
      if (text === '.') {
        awaiting = 'nothing';
        const answer = script.afterData ?? OK;
        if (answer.startsWith('2')) {
          relay.received.push({ from: envelope.from, to: envelope.to, data: data.join('\n') });
        }
        say(answer);
      } else {
        data.push(text.startsWith('..') ? text.slice(1) : text);
      }
      return;
    }
    if (awaiting === 'plain') {
      awaiting = 'nothing';
      const [, user = '', pass = ''] = decoded(text).split('\u0000');
      weigh(user, pass, text);
      return;
    }
    if (awaiting === 'login-user') {
      loginUser = decoded(text);
      awaiting = 'login-pass';
      say('334 UGFzc3dvcmQ6');
      return;
    }
    if (awaiting === 'login-pass') {
      awaiting = 'nothing';
      weigh(loginUser, decoded(text), text);
      return;
    }
    const [verb = '', ...rest] = text.split(' ');
    switch (verb.toUpperCase()) {
      case 'EHLO': {
        if (script.ehloReply !== undefined) {
          say(script.ehloReply);
          return;
        }
        if (script.dribble === true) {
          const ticking = setInterval(() => {
            if (socket.destroyed) clearInterval(ticking);
            else say('250-relay.test');
          }, 50);
          socket.on('close', () => {
            clearInterval(ticking);
          });
          return;
        }
        const offers = [
          ...(script.starttls !== undefined && !secure ? ['STARTTLS'] : []),
          ...(script.login !== undefined ? ['AUTH PLAIN LOGIN'] : []),
        ];
        const lines = ['relay.test', ...offers];
        lines.forEach((part, index) => {
          say(`250${index === lines.length - 1 ? ' ' : '-'}${part}`);
        });
        return;
      }
      case 'HELO':
        say('250 relay.test');
        return;
      case 'STARTTLS': {
        const certificate = script.starttls;
        if (certificate === undefined || secure) {
          say('502 5.5.1 STARTTLS not offered');
          return;
        }
        say('220 2.0.0 Ready to start TLS');
        socket.removeAllListeners('data');
        const upgraded = new tls.TLSSocket(socket, {
          isServer: true,
          cert: certificate.cert,
          key: certificate.key,
        });
        upgraded.on('error', () => undefined);
        socket = upgraded;
        secure = true;
        buffered = '';
        listen(upgraded);
        return;
      }
      case 'AUTH': {
        const [mechanism = '', initial] = rest;
        if (mechanism.toUpperCase() === 'PLAIN') {
          if (initial === undefined) {
            awaiting = 'plain';
            say('334 ');
          } else {
            const [, user = '', pass = ''] = decoded(initial).split('\u0000');
            weigh(user, pass, initial);
          }
          return;
        }
        if (mechanism.toUpperCase() === 'LOGIN') {
          if (initial === undefined) {
            awaiting = 'login-user';
            say('334 VXNlcm5hbWU6');
          } else {
            loginUser = decoded(initial);
            awaiting = 'login-pass';
            say('334 UGFzc3dvcmQ6');
          }
          return;
        }
        say('504 5.5.4 Unrecognized authentication type');
        return;
      }
      case 'MAIL': {
        if (script.login !== undefined && !signedIn) {
          say('530 5.7.0 Authentication required');
          return;
        }
        envelope = { from: addressIn(text), to: [] };
        say(script.mailFrom?.(envelope.from) ?? OK);
        return;
      }
      case 'RCPT': {
        const to = addressIn(text);
        const answer = script.rcptTo?.(to) ?? OK;
        if (answer.startsWith('2')) envelope.to.push(to);
        say(answer);
        return;
      }
      case 'DATA':
        if (script.dataReply !== undefined) {
          say(script.dataReply);
          return;
        }
        data = [];
        awaiting = 'data';
        say('354 End data with <CR><LF>.<CR><LF>');
        return;
      case 'RSET':
        envelope = { from: '', to: [] };
        say(OK);
        return;
      case 'QUIT':
        say('221 2.0.0 Bye');
        socket.end();
        return;
      default:
        say('500 5.5.2 Unrecognized command');
    }
  };

  const listen = (on: net.Socket): void => {
    on.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      for (let end = buffered.indexOf('\r\n'); end !== -1; end = buffered.indexOf('\r\n')) {
        const text = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        line(text);
      }
    });
  };

  first.on('error', () => undefined);
  if (script.silent === true) return;
  listen(first);
  say(script.greeting ?? '220 relay.test ESMTP ready');
};

/** The relay, listening on the loopback address at a port of its own. */
export const aScriptedRelay = async (script: RelayScript = {}): Promise<ScriptedRelay> => {
  const sockets = new Set<net.Socket>();
  const relay: { port: number; commands: string[]; received: Received[] } = {
    port: 0,
    commands: [],
    received: [],
  };
  const accept = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    converse(socket, script, relay);
  };
  const server =
    script.implicitTls === undefined
      ? net.createServer(accept)
      : tls.createServer({ cert: script.implicitTls.cert, key: script.implicitTls.key }, accept);
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the relay has no port');
  relay.port = address.port;
  return {
    port: relay.port,
    commands: relay.commands,
    received: relay.received,
    openSockets: () => sockets.size,
    stop: async (): Promise<void> => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};

/** A port nothing listens on: one the system handed out and took back. */
export const aClosedPort = async (): Promise<number> => {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return address.port;
};
