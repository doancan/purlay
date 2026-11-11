import { expect, test } from 'bun:test';
import type { Attachment } from '@purlay/types';
import { accountChanged } from '../../../data/errors';
import { memoryStorage } from '../../../testing/fakes';
import { createOutbox } from './outbox';

test('a refused offscreen enqueue preserves ready files and the draft and requires a deliberate new send', () => {
  const storage = memoryStorage({ draft: 'Keep these words' });
  const attachment: Attachment = {
    id: '0199155c-6200-7b7f-8c11-0000000000d1',
    fileName: 'keep.txt',
    mimeType: 'text/plain',
    sizeBytes: 4,
    kind: 'file',
    width: null,
    height: null,
  };
  let allowed = false;
  let attempts = 0;
  const refusals: string[] = [];
  const accepted: string[] = [];
  const outbox = createOutbox({
    upload: () => Promise.resolve(attachment),
    refusal: () => ({ reason: 'NETWORK', remainingBytes: null }),
    send: (message) => {
      attempts += 1;
      if (!allowed) throw accountChanged();
      accepted.push(message.content);
    },
    refused: (_channel, reason) => {
      refusals.push(reason);
    },
  });
  outbox.add('draft', [
    {
      id: attachment.id,
      name: attachment.fileName,
      file: new Blob(['keep']),
      workspaceId: 'workspace',
      status: 'ready',
      attachment,
    },
  ]);
  const waiting = {
    channelId: 'channel',
    parentId: undefined,
    channelName: 'Private place',
    content: 'Keep these words',
    storage,
  };
  const leave = outbox.hold('draft');
  outbox.wait('draft', waiting);
  expect(() => {
    leave(waiting.content);
  }).not.toThrow();
  expect(outbox.read('draft').items.map((item) => item.name)).toEqual(['keep.txt']);
  expect(outbox.read('draft').waiting === null).toBe(true);
  expect(storage.getItem('draft')).toBe('Keep these words');
  expect(refusals).toEqual(['account']);
  expect(attempts).toBe(1);
  const release = outbox.hold('draft');
  release('Unrequested retry');
  expect(attempts).toBe(1);
  allowed = true;
  const leaveAgain = outbox.hold('draft');
  outbox.wait('draft', waiting);
  leaveAgain(waiting.content);
  expect(accepted).toEqual(['Keep these words']);
  expect(attempts).toBe(2);
  expect(storage.getItem('draft') === null).toBe(true);
  expect(outbox.read('draft').items).toHaveLength(0);
});
