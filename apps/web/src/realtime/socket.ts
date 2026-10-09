/**
 * The browser's socket and timers, adapted to the shapes `connection.ts` takes.
 *
 * Kept apart so that file never names `WebSocket` or `setTimeout`, and a test can
 * hand it a socket it controls. Too thin to hold a decision of its own — which is
 * why it has no test of its own: what it would assert is the browser's behaviour.
 */
import type { OpenSocket, Schedule } from './connection';

export const browserSocket: OpenSocket = (url, handlers) => {
  const socket = new WebSocket(url);
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

export const browserSchedule: Schedule = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return (): void => {
    clearTimeout(handle);
  };
};
