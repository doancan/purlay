/**
 * Sending mail (#81, D-138 §6), without a network: what the transport is built from — TLS required past
 * this machine, credentials decoded, the timeouts given — and the outbox, which starts a send without
 * waiting, says a failure by its purpose and code alone, and is waited for on shutdown.
 */
import { describe, expect, test } from 'bun:test';
import { aRecordingLogger } from '../testing/doubles';
import { checkRelay, letter, outbox, smtpMailer, transportOptions, type MailMessage } from './mail';

const allow = { SMTP_ALLOW_PLAINTEXT: false };

describe('the transport', () => {
  test('smtps:// is TLS from the start, on 465 unless said', () => {
    expect(transportOptions({ ...allow, SMTP_URL: 'smtps://mail.example.com' })).toMatchObject({
      host: 'mail.example.com',
      port: 465,
      secure: true,
      requireTLS: false,
    });
  });

  test('smtp:// past this machine must upgrade, on 587 unless said — unless the link is private', () => {
    expect(transportOptions({ ...allow, SMTP_URL: 'smtp://mail.example.com' })).toMatchObject({
      port: 587,
      secure: false,
      requireTLS: true,
    });
    expect(
      transportOptions({ SMTP_ALLOW_PLAINTEXT: true, SMTP_URL: 'smtp://mail.internal:25' }),
    ).toMatchObject({ port: 25, requireTLS: false });
  });

  test('a relay on this machine need not upgrade', () => {
    for (const SMTP_URL of ['smtp://localhost:25', 'smtp://127.0.0.1:25', 'smtp://[::1]:25']) {
      expect(transportOptions({ ...allow, SMTP_URL }).requireTLS).toBe(false);
    }
    expect(transportOptions({ ...allow, SMTP_URL: 'smtp://[::1]:25' }).host).toBe('::1');
  });

  test('credentials are the URL’s, decoded; none is no auth at all; the timeouts are given', () => {
    const options = transportOptions({
      ...allow,
      SMTP_URL: 'smtps://purlay%40example.com:p%40ss%2Fword@mail.example.com',
    });
    expect(options.auth).toEqual({ user: 'purlay@example.com', pass: 'p@ss/word' });
    expect(
      transportOptions({ ...allow, SMTP_URL: 'smtps://mail.example.com' }).auth,
    ).toBeUndefined();
    expect(options.connectionTimeout).toBeGreaterThan(0);
    expect(options.socketTimeout).toBeGreaterThan(0);
  });
});

describe('the outbox', () => {
  const letter_: MailMessage = {
    to: 'alice@example.test',
    subject: 'Your sign-in link',
    text: 'https://purlay.test/sign-in/email#secret-token',
    html: '<p>https://purlay.test/sign-in/email#secret-token</p>',
  };

  test('starts a send and returns; flush waits for it', async () => {
    const { log } = aRecordingLogger();
    let release: () => void = () => undefined;
    const sent: MailMessage[] = [];
    const box = outbox(
      (message) =>
        new Promise<void>((resolve) => {
          sent.push(message);
          release = resolve;
        }),
      log,
    );
    box.post(letter_, 'sign-in');
    expect(sent).toEqual([letter_]);
    let flushed = false;
    const flushing = box.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    release();
    await flushing;
    expect(flushed).toBe(true);
  });

  test('a failure is said by its purpose and the relay’s code — never to whom, never what it said', async () => {
    const { log, lines } = aRecordingLogger();
    const box = outbox(
      () =>
        Promise.reject(
          Object.assign(new Error('550 5.1.1 <alice@example.test>: user unknown'), {
            code: 'EENVELOPE',
          }),
        ),
      log,
    );
    box.post(letter_, 'sign-in');
    await box.flush();
    expect(lines.map((line) => [line['msg'], line['purpose'], line['reason']])).toEqual([
      ['mail could not be sent', 'sign-in', 'EENVELOPE'],
    ]);
    const written = JSON.stringify(lines);
    expect(written).not.toContain('alice@example.test');
    expect(written).not.toContain('secret-token');
  });

  test('flush waits no longer than its bound, and says how many it left', async () => {
    const { log, lines } = aRecordingLogger();
    const box = outbox(() => new Promise<void>(() => undefined), log);
    box.post(letter_, 'sign-in');
    await box.flush(5);
    expect(lines.map((line) => [line['msg'], line['sending']])).toEqual([
      ['mail left at shutdown', 1],
    ]);
  });

  test('a flush with nothing out says nothing', async () => {
    const { log, lines } = aRecordingLogger();
    await outbox(() => Promise.resolve(), log).flush(5);
    expect(lines).toEqual([]);
  });
});

describe('what the relay is handed', () => {
  test('the envelope names the one recipient, from MAIL_FROM', () => {
    const message: MailMessage = {
      to: 'a@example.test',
      subject: 's',
      text: 't',
      html: '<p>t</p>',
    };
    expect(letter(message, 'Purlay <no-reply@purlay.test>')).toEqual({
      ...message,
      from: 'Purlay <no-reply@purlay.test>',
      envelope: { from: 'Purlay <no-reply@purlay.test>', to: ['a@example.test'] },
    });
  });
});

describe('the relay, checked at start', () => {
  test('answering is said; not answering is an error, by its code alone', async () => {
    const answering = aRecordingLogger();
    await checkRelay(
      { send: () => Promise.resolve(), verify: () => Promise.resolve() },
      answering.log,
    );
    expect(answering.lines.map((line) => line['msg'])).toEqual(['mail relay answers']);

    const silent = aRecordingLogger();
    await checkRelay(
      {
        send: () => Promise.resolve(),
        verify: () =>
          Promise.reject(
            Object.assign(new Error('535 auth failed for purlay@example.com'), { code: 'EAUTH' }),
          ),
      },
      silent.log,
    );
    expect(silent.lines.map((line) => [line['level'], line['reason']])).toEqual([
      ['error', 'EAUTH'],
    ]);
    expect(JSON.stringify(silent.lines)).not.toContain('purlay@example.com');
  });
});

/**
 * A relay on this machine that speaks just enough SMTP to accept a message, and records each command:
 * what nodemailer actually tells a relay, not what its options say it will.
 */
const aRelay = (
  greeting = '220 relay.test ready',
): {
  readonly port: number;
  readonly commands: string[];
  readonly stop: () => void;
} => {
  const commands: string[] = [];
  let inData = false;
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: (socket) => {
        socket.write(`${greeting}\r\n`);
      },
      data: (socket, chunk) => {
        for (const line of chunk
          .toString()
          .split('\r\n')
          .filter((part) => part !== '')) {
          if (inData) {
            if (line === '.') {
              inData = false;
              socket.write('250 queued\r\n');
            }
            continue;
          }
          commands.push(line);
          const verb = line.split(/[ :]/)[0]?.toUpperCase();
          if (verb === 'EHLO' || verb === 'HELO') socket.write('250 relay.test\r\n');
          else if (verb === 'DATA') {
            inData = true;
            socket.write('354 go on\r\n');
          } else if (verb === 'QUIT') {
            socket.write('221 bye\r\n');
            socket.end();
          } else socket.write('250 ok\r\n');
        }
      },
    },
  });
  return {
    port: server.port,
    commands,
    stop: (): void => {
      server.stop(true);
    },
  };
};

describe('the relay, spoken to', () => {
  const settings = (port: number): Parameters<typeof smtpMailer>[0] => ({
    SMTP_URL: `smtp://127.0.0.1:${String(port)}`,
    MAIL_FROM: 'Purlay <no-reply@purlay.test>',
    SMTP_ALLOW_PLAINTEXT: false,
  });

  test('a message goes to its one recipient, from MAIL_FROM, and the relay is asked nothing else', async () => {
    const relay = aRelay();
    try {
      await smtpMailer(settings(relay.port)).send({
        to: 'a@example.test',
        subject: 'Your sign-in link',
        text: 'words',
        html: '<p>words</p>',
      });
      expect(relay.commands.filter((line) => /^(MAIL|RCPT)/i.test(line))).toEqual([
        'MAIL FROM:<no-reply@purlay.test>',
        'RCPT TO:<a@example.test>',
      ]);
    } finally {
      relay.stop();
    }
  });

  test('a relay that answers is said to; one that refuses fails the check', async () => {
    const answering = aRelay();
    const refusing = aRelay('554 no service here');
    try {
      await smtpMailer(settings(answering.port)).verify();
      expect(answering.commands[0]).toMatch(/^EHLO /);
      expect(
        await smtpMailer(settings(refusing.port))
          .verify()
          .then(
            () => 'answered',
            () => 'refused',
          ),
      ).toBe('refused');
    } finally {
      answering.stop();
      refusing.stop();
    }
  });
});
