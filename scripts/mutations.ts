/**
 * The mutations `bun run mutate` applies (`scripts/mutate.ts`, `CONTRIBUTING.md` §5).
 *
 * Each is something a reviewer could plausibly let through, written against the code
 * as it is: when the code moves, the entry goes stale and the run says so.
 */
import type { Mutation } from './mutate';

const WORKSPACES = 'apps/api/src/modules/workspaces/workspaces.ts';
const WORKSPACES_TESTS = ['apps/api/src/modules/workspaces/workspaces.integration.test.ts'];

const MESSAGES = 'apps/api/src/modules/messages/messages.ts';
const MESSAGES_TESTS = ['apps/api/src/modules/messages/messages.integration.test.ts'];

const SOCKET = 'apps/api/src/ingress/ws/socket.ts';
const SOCKET_TESTS = ['apps/api/src/realtime/sockets.integration.test.ts'];

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'oauth-state-length-check-removed',
    why: 'the comparison walks its first argument only, so an empty or truncated signature compares equal and the state needs no signature at all',
    file: 'apps/api/src/modules/auth/state.ts',
    find: '  if (a.length !== b.length) return false;\n',
    replace: '',
    tests: ['apps/api/src/modules/auth/state.test.ts'],
  },
  {
    id: 'oauth-callback-accepted-without-a-code',
    why: 'a callback with a valid state and no code goes on to ask GitHub to exchange nothing',
    file: 'apps/api/src/modules/auth/sign-in.ts',
    find: 'if (!valid || code === undefined) {',
    replace: 'if (!valid) {',
    tests: ['apps/api/src/modules/auth/sign-in.test.ts'],
  },
  {
    id: 'session-lifetime-maximum-raised',
    why: 'a configured session may live ten years, so a stolen cookie is worth that long',
    file: 'apps/api/src/platform/config.ts',
    find: 'SESSION_TTL_DAYS: Type.Integer({ minimum: 1, maximum: 365, default: 30 })',
    replace: 'SESSION_TTL_DAYS: Type.Integer({ minimum: 1, maximum: 3650, default: 30 })',
    tests: ['apps/api/src/platform/config.test.ts'],
  },
  {
    id: 'session-lifetime-minimum-lowered',
    why: 'a configured lifetime of zero days mints sessions that are expired when issued',
    file: 'apps/api/src/platform/config.ts',
    find: 'SESSION_TTL_DAYS: Type.Integer({ minimum: 1, maximum: 365, default: 30 })',
    replace: 'SESSION_TTL_DAYS: Type.Integer({ minimum: 0, maximum: 365, default: 30 })',
    tests: ['apps/api/src/platform/config.test.ts'],
  },
  {
    id: 'hub-expiry-timer-not-cancelled-on-close',
    why: 'every connection that ever closed leaves a timer behind, for as long as its session had to live',
    file: 'apps/api/src/realtime/hub.ts',
    find: '      held.get(socketId)?.cancelExpiry?.();\n',
    replace: '',
    tests: ['apps/api/src/realtime/hub.integration.test.ts'],
  },
  {
    id: 'bus-not-told-a-socket-closed',
    why: 'the bus keeps every closed socket and its topics, growing with each connection',
    file: SOCKET,
    find: '      bus.forget(socket.id);\n',
    replace: '',
    tests: SOCKET_TESTS,
  },
  {
    id: 'limiter-not-told-a-socket-closed',
    why: 'the limiter keeps a bucket for every socket that ever connected',
    file: SOCKET,
    find: '      limiter.forget(socket.id);\n',
    replace: '',
    tests: SOCKET_TESTS,
  },
  {
    id: 'hub-not-told-a-socket-closed',
    why: 'the hub keeps the closed connection and writes to it',
    file: SOCKET,
    find: '      hub.closed(socket.id);\n',
    replace: '',
    tests: SOCKET_TESTS,
  },
  {
    id: 'web-connection-accepts-frames-from-a-replaced-socket',
    why: 'a late frame from an old socket advances a cursor past messages the new connection has not replayed',
    file: 'apps/web/src/realtime/connection.ts',
    find: '      message: (data): void => {\n        if (mine !== generation) return;\n',
    replace: '      message: (data): void => {\n',
    tests: ['apps/web/src/realtime/connection.test.ts'],
  },
  {
    id: 'send-announces-before-the-commit',
    why: 'subscribers receive a message that then rolls back, and nothing can retract the frame',
    file: MESSAGES,
    find: `  const message = await atomically(
    async (transaction) => await sendMessage(transaction, clock, context, input),
  );
  await bus.publish(channelTopic(context.channelId), {
    event: 'MESSAGE_CREATED',
    data: message,
    ts: clock.now().getTime(),
  });
  return message;`,
    replace: `  return await atomically(async (transaction) => {
    const sent = await sendMessage(transaction, clock, context, input);
    await bus.publish(channelTopic(context.channelId), {
      event: 'MESSAGE_CREATED',
      data: sent,
      ts: clock.now().getTime(),
    });
    return sent;
  });`,
    tests: ['apps/api/src/modules/messages/send-order.integration.test.ts'],
  },
  {
    id: 'retry-ignores-the-channel-on-conflict',
    why: 'the same sender re-using an id from another channel is acknowledged, so a message is reported stored where it is not',
    file: MESSAGES,
    find: ' && existing.channel_id === context.channelId;',
    replace: ';',
    tests: MESSAGES_TESTS,
  },
  {
    id: 'retry-ignores-the-channel-outside-the-window',
    why: 'a late retry from another channel returns a message from a channel it was not sent to',
    file: MESSAGES,
    find: 'if (existing?.sender_id === context.userId && existing.channel_id === context.channelId) {',
    replace: 'if (existing?.sender_id === context.userId) {',
    tests: MESSAGES_TESTS,
  },
  {
    id: 'history-includes-deleted-messages',
    why: 'a deleted message is served to every reader of the channel',
    file: MESSAGES,
    find: "    .where('messages.deleted_at', 'is', null)\n    // Ascending when",
    replace: '    // Ascending when',
    tests: MESSAGES_TESTS,
  },
  {
    id: 'replay-includes-deleted-messages',
    why: 'a reconnect replays a message that was deleted',
    file: MESSAGES,
    find: "          .where('messages.deleted_at', 'is', null)\n          .orderBy('messages.id', 'asc')",
    replace: "          .orderBy('messages.id', 'asc')",
    tests: MESSAGES_TESTS,
  },
  {
    id: 'history-limit-not-capped',
    why: 'one request reads the whole channel',
    file: MESSAGES,
    find: 'Math.min(Math.max(query.limit ?? PAGE_LIMIT.default, 1), PAGE_LIMIT.max)',
    replace: 'Math.max(query.limit ?? PAGE_LIMIT.default, 1)',
    tests: MESSAGES_TESTS,
  },
  {
    id: 'history-limit-not-floored',
    why: 'a limit of zero or less returns nothing, or a database error',
    file: MESSAGES,
    find: 'Math.min(Math.max(query.limit ?? PAGE_LIMIT.default, 1), PAGE_LIMIT.max)',
    replace: 'Math.min(query.limit ?? PAGE_LIMIT.default, PAGE_LIMIT.max)',
    tests: MESSAGES_TESTS,
  },
  {
    id: 'member-list-includes-deleted-users',
    why: 'a deleted account is listed as a member of the workspace',
    file: WORKSPACES,
    find: "    .where('users.deleted_at', 'is', null)\n",
    replace: '',
    tests: WORKSPACES_TESTS,
  },
  {
    id: 'me-lists-deleted-workspaces',
    why: '/api/me hands the client a workspace that no longer exists to try to open',
    file: WORKSPACES,
    find: "    .where('workspaces.deleted_at', 'is', null)\n    .orderBy('workspace_members.joined_at', 'asc')",
    replace: "    .orderBy('workspace_members.joined_at', 'asc')",
    tests: WORKSPACES_TESTS,
  },
  {
    id: 'me-answers-for-a-deleted-user',
    why: 'a deleted account still gets its profile and email from /api/me',
    file: WORKSPACES,
    find: "    .where('id', '=', userId)\n    .where('deleted_at', 'is', null)\n",
    replace: "    .where('id', '=', userId)\n",
    tests: WORKSPACES_TESTS,
  },
  {
    id: 'workspace-read-ignores-deletion',
    why: 'a workspace deleted under a live context is still read and returned',
    file: WORKSPACES,
    find: "    .where('id', '=', context.workspaceId)\n    .where('deleted_at', 'is', null)\n",
    replace: "    .where('id', '=', context.workspaceId)\n",
    tests: WORKSPACES_TESTS,
  },
  {
    id: 'oauth-state-signature-unchecked',
    why: 'a cookie an attacker wrote is accepted, so the callback signs a victim into the attacker’s account',
    file: 'apps/api/src/modules/auth/state.ts',
    find: 'if (!equal(signature, await sign(encryptionKey, payload))) return false;',
    replace: '',
    tests: ['apps/api/src/modules/auth/state.test.ts'],
  },
];
