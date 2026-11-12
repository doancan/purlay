/** Actual ungraceful death, after commit or during provider handoff. Used only by push-crash.integration.test.ts. */
import { writeFileSync } from 'node:fs';
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
const context = await requireChannelById(
  database,
  required('PUSH_WRITER'),
  required('PUSH_CHANNEL'),
);
await send({ atomically: atomicallyOn(database), clock, bus }, context, {
  id: messageId(clock.now()),
  content: 'Private crash fixture message',
});
if (required('PUSH_CRASH_STAGE') === 'committed') process.kill(process.pid, 'SIGKILL');
const sender = await createPushSender({
  database,
  clock,
  log: NO_LOG,
  keys,
  attention: nobodyActive,
  notices: chatPushNotices,
  noticeWords: noNoticeWords,
  ...TEST_PUSH_POLICY,
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
