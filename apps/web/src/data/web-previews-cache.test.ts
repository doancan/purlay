/** Hidden and revoked messages must forget even late decorative metadata. */
import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { channelsRevoked, messageHidden, messageRevised } from './cache';
import { keys } from './keys';
import { aMessage, IDS, WHEN } from '../testing/fixtures';

const card = { title: 'Shift report', description: null, imageUrl: null };
const url = 'https://docs.example/report';
test.each(['hide', 'hide-without-channel', 'revoke', 'delete'] as const)(
  '%s forgets a cached card and a pending answer, preserving unrelated channels and messages',
  async (change) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const message = aMessage(1);
    const key = keys.webLinkPreview(IDS.api, message.id, url);
    const other = keys.webLinkPreview(IDS.incidents, aMessage(2).id, url);
    const sameChannel = keys.webLinkPreview(IDS.api, aMessage(3).id, url);
    const late = keys.webLinkPreview(IDS.api, message.id, `${url}/late`);
    const pending = Promise.withResolvers<typeof card>();
    client.setQueryData(key, card);
    client.setQueryData(other, card);
    client.setQueryData(sameChannel, card);
    const task = client.query({ queryKey: late, queryFn: () => pending.promise }).catch(() => null);
    if (change === 'revoke') channelsRevoked(client, [IDS.api]);
    else if (change === 'delete')
      messageRevised(client, {
        channelId: IDS.api,
        messageId: message.id,
        parentId: null,
        content: '',
        editedAt: null,
        deletedAt: WHEN,
        mentions: [],
      });
    else messageHidden(client, message.id, WHEN, change === 'hide' ? IDS.api : undefined);
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getQueryData(late)).toBeUndefined();
    expect(client.getQueryData(other)).toEqual(card);
    expect(client.getQueryData(sameChannel)).toEqual(change === 'revoke' ? undefined : card);
    pending.resolve(card);
    await task;
    expect(client.getQueryData(late)).toBeUndefined();
    client.clear();
  },
);
