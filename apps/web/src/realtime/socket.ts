/**
 * The browser's socket and timers, adapted to the shapes `connection.ts` takes.
 *
 * Kept apart so that file never names `WebSocket` or `setTimeout`, and a test can
 * hand it a socket it controls. The constructor is an argument for the same
 * reason: the adapter is tested against a stand-in that fires events on demand,
 * because the browser's own behaviour is not what is being asserted.
 */
import type { OpenSocket, Schedule } from './connection';

/** The part of `WebSocket` this adapter uses. */
export interface WebSocketLike {
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: { code: number }) => void): void;
  send(text: string): void;
  close(): void;
}

export const createBrowserSocket =
  (Socket: new (url: string) => WebSocketLike): OpenSocket =>
  (url, handlers) => {
    const socket = new Socket(url);
    socket.addEventListener('open', handlers.opened);
    socket.addEventListener('message', (event) => {
      handlers.message(event.data);
    });
    socket.addEventListener('close', (event) => {
      handlers.closed(event.code);
    });
    return {
      send: (text): void => {
        socket.send(text);
      },
      close: (): void => {
        socket.close();
      },
    };
  };

export const browserSocket: OpenSocket = createBrowserSocket(WebSocket);

export const browserSchedule: Schedule = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return (): void => {
    clearTimeout(handle);
  };
};
