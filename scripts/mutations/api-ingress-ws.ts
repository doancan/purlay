// Area api-ingress-ws: ids ascending; areas.ts says what belongs here.
import type { Mutation } from '../mutate';
import { SOCKET_TESTS } from './shared';

const SOCKET = 'apps/api/src/ingress/ws/socket.ts';

export const API_INGRESS_WS: readonly Mutation[] = [
  {
    id: 'bus-not-told-a-socket-closed',
    why: 'the bus keeps every closed socket and its topics, growing with each connection',
    file: SOCKET,
    find: '      bus.forget(socket.id);\n',
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
    id: 'limiter-not-told-a-socket-closed',
    why: 'the limiter keeps a bucket for every socket that ever connected',
    file: SOCKET,
    find: '      limiter.forget(socket.id);\n',
    replace: '',
    tests: SOCKET_TESTS,
  },
  {
    id: 'presence-directory-not-shared',
    why: 'a person online on the other node is offline to this one: half the workspace reads as away',
    file: 'apps/api/src/ingress/ws/socket.ts',
    find: '          ...(dependencies.shared === undefined\n            ? {}\n            : { directory: dependencies.shared.directory }),\n',
    replace: '',
    tests: ['apps/api/src/realtime/shared-nodes.redis.integration.test.ts'],
  },
  {
    id: 'push-socket-door-silent',
    why: 'a message sent over the socket — most of them — tells nobody’s device',
    file: 'apps/api/src/ingress/ws/socket.ts',
    find: '                  push: dependencies.push,\n',
    replace: '',
    tests: ['apps/api/src/realtime/sockets.integration.test.ts'],
  },
  {
    id: 'redis-bus-gap-not-acted-on',
    why: 'a node told it missed frames leaves its sockets open instead of sending them to replay from their cursors',
    file: 'apps/api/src/ingress/ws/socket.ts',
    find: "    hub.closeAll(CLOSE_CODES.RESTARTING, 'resync');\n",
    replace: '',
    tests: ['apps/api/src/realtime/shared-nodes.redis.integration.test.ts'],
  },
  {
    id: 'socket-cap-ignores-the-configuration',
    why: 'the node’s socket total is the old fixed 2000 again, whatever SOCKET_MAX_CONNECTIONS says: an operator who lowers it to protect a node, or raises it after measuring, changes nothing (#1027)',
    file: 'apps/api/src/ingress/ws/socket.ts',
    find: '    total: dependencies.config.SOCKET_MAX_CONNECTIONS,\n',
    replace: '    total: 2_000,\n',
    tests: ['apps/api/src/realtime/socket-limits.integration.test.ts'],
  },
  {
    id: 'socket-cap-only-at-the-door',
    why: 'a burst of upgrades that all pass the check before any is counted holds more sockets than an account may',
    file: 'apps/api/src/ingress/ws/socket.ts',
    find: '      if (identity !== undefined && hub.connectionsOf(identity.userId) > limits.perUser) {\n',
    replace: '      if (identity !== undefined && false) {\n',
    tests: ['apps/api/src/realtime/socket-limits.integration.test.ts'],
  },
  {
    id: 'socket-presence-kept-without-chat',
    why: 'a socket of a process that does not run chat still counts people online and tells their colleagues, in the news of a module that is off (D-250)',
    file: 'apps/api/src/ingress/ws/socket.ts',
    find: "dependencies.closedEvent?.('PRESENCE') === true",
    replace: 'false as boolean',
    tests: [
      'apps/api/src/ingress/ws/socket.test.ts',
      'apps/api/src/realtime/modules-off-presence.integration.test.ts',
    ],
  },
  {
    id: 'socket-rate-refusal-counted-under-none',
    why: 'a socket frame refused for the rate is counted under no module though its operation is a module’s, so the module whose frames are flooding is not the one the page names (D-250 rule 7)',
    file: 'apps/api/src/ingress/ws/socket.ts',
    find: 'module: dependencies.frameOwner?.(operationOf(raw)) ?? NO_OWNER,',
    replace: 'module: NO_OWNER,',
    tests: ['apps/api/src/ingress/http/metrics.integration.test.ts'],
  },
  {
    id: 'typing-registry-not-shared',
    why: 'the sockets keep a typing window of their own with Redis: the room is told once per node a person types through',
    file: 'apps/api/src/ingress/ws/socket.ts',
    find: 'dependencies.shared?.typing ?? inMemoryPresenceRegistry(clock)',
    replace: 'inMemoryPresenceRegistry(clock)',
    tests: ['apps/api/src/realtime/shared-nodes.redis.integration.test.ts'],
  },
];
