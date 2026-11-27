/** Sender process for the crash and real transport restart tests. */
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { createDatabase } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../platform/clock';
import { nobodyActive } from '../platform/attention';
import { NO_LOG, type EventBus } from '../platform/events';
import { atomicallyOn } from '../platform/transactions';
import { requireChannelById } from '../features/chat/channels/guard';
import { send } from '../features/chat/messages/messages';
import { chatPushNotices } from '../features/chat/notifications/push-notices';
import { createPushSender } from '../modules/push/sender';
import { noNoticeWords } from '../modules/push/notices';
import { checkingLookup, postExternal } from '../modules/images/fetch-external';
import { TEST_PUSH_POLICY } from './push-config';

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`Missing crash fixture variable ${name}`);
  return value;
};
const database = createDatabase({ connectionString: required('DATABASE_URL') });
const clock = fixedClock(new Date(required('PUSH_CLOCK')));
const keys = {
  publicKey: required('PUSH_PUBLIC_KEY'),
  privateKey: required('PUSH_PRIVATE_KEY'),
  subject: required('PUSH_SUBJECT'),
};
const bus: EventBus = {
  publish: (): Promise<void> => Promise.resolve(),
  subscribe: (): boolean => false,
  unsubscribe: (): void => undefined,
  forget: (): void => undefined,
};
const stage = required('PUSH_CRASH_STAGE');
if (stage !== 'retry-restart') {
  const context = await requireChannelById(
    database,
    required('PUSH_WRITER'),
    required('PUSH_CHANNEL'),
  );
  const mention = process.env['PUSH_MENTION'];
  await send({ atomically: atomicallyOn(database), clock, bus }, context, {
    id: messageId(clock.now()),
    content:
      mention === undefined
        ? 'Private crash fixture message'
        : `@${mention} Private crash fixture message`,
  });
}
if (stage === 'committed') process.kill(process.pid, 'SIGKILL');
const dependencies = {
  database,
  clock,
  log: NO_LOG,
  keys,
  attention: nobodyActive,
  notices: chatPushNotices,
  noticeWords: noNoticeWords,
  ...TEST_PUSH_POLICY,
};

if (stage === 'retry-initial' || stage === 'retry-restart') {
  const port = Number(required('PUSH_LOOPBACK_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid test port');
  const lookup = checkingLookup(
    () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    (address) => address === '127.0.0.1',
  );
  await createPushSender({
    ...dependencies,
    post: async (url, headers, body) =>
      await postExternal(url, headers, body, { lookup, transport: http, port, timeoutMs: 2_000 }),
  });
  // The sender's startup and poll timers are unref'd. The parent ends this fixture after observing SQL.
  await Bun.sleep(20_000);
  throw new Error('The parent did not end the loopback sender');
}

const sender = await createPushSender({
  ...dependencies,
  post: (_url, headers, body): never => {
    writeFileSync(
      required('PUSH_CHECKPOINT'),
      JSON.stringify({ headers, body: Buffer.from(body).toString('base64') }),
      { mode: 0o600 },
    );
    process.kill(process.pid, 'SIGKILL');
    throw new Error('Crash fixture unexpectedly survived SIGKILL');
  },
});
await sender.flush();
throw new Error('Crash fixture did not reach its requested stage');
