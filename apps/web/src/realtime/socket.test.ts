import { describe, expect, test } from 'bun:test';
import type { SocketHandlers } from './connection';
import { browserSchedule, createBrowserSocket, type WebSocketLike } from './socket';

type Listener = (event: never) => void;

class StandIn implements WebSocketLike {
  static last: StandIn | null = null;
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Listener>();

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    StandIn.last = this;
  }

  addEventListener(type: 'open' | 'message' | 'close', listener: Listener): void {
    this.listeners.set(type, listener);
  }

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    this.closed = true;
  }

  fire(type: 'open' | 'message' | 'close', event: object): void {
    const listener = this.listeners.get(type);
    if (listener === undefined) throw new Error(`nothing listens for ${type}`);
    // The stand-in is the browser here: it delivers whatever shape the test names.
    listener(event as never);
  }
}

const open = (): { socket: StandIn; handlers: SocketHandlers; seen: string[] } => {
  const seen: string[] = [];
  const handlers: SocketHandlers = {
    opened: (): void => {
      seen.push('opened');
    },
    message: (data): void => {
      seen.push(`message:${String(data)}`);
    },
    closed: (code): void => {
      seen.push(`closed:${String(code)}`);
    },
  };
  createBrowserSocket(StandIn)('ws://test/ws', handlers).send('hello');
  const socket = StandIn.last;
  if (socket === null) throw new Error('no socket was created');
  return { socket, handlers, seen };
};

describe('the browser socket adapter', () => {
  test('connects to the url it is given and passes sends through', () => {
    const { socket } = open();
    expect(socket.url).toBe('ws://test/ws');
    expect(socket.sent).toEqual(['hello']);
  });

  test('reports open, message and close in the connection’s terms', () => {
    const { socket, seen } = open();
    socket.fire('open', {});
    socket.fire('message', { data: 'frame' });
    socket.fire('close', { code: 4408 });
    expect(seen).toEqual(['opened', 'message:frame', 'closed:4408']);
  });

  test('close closes the socket', () => {
    const seen: StandIn[] = [];
    const socket = createBrowserSocket(StandIn)('ws://test/ws', {
      opened: (): void => undefined,
      message: (): void => undefined,
      closed: (): void => undefined,
    });
    socket.close();
    const created = StandIn.last;
    if (created !== null) seen.push(created);
    expect(seen[0]?.closed).toBe(true);
  });
});

describe('the browser scheduler', () => {
  test('runs a function later, and not at all once cancelled', async () => {
    const ran: string[] = [];
    browserSchedule(() => {
      ran.push('kept');
    }, 1);
    const cancel = browserSchedule(() => {
      ran.push('cancelled');
    }, 1);
    cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toEqual(['kept']);
  });
});
