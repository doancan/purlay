/**
 * Whether something accepts connections at the database's address, within a second. Shared by the
 * scripts that need a database and must say plainly when there is none (`test-all.ts`,
 * `budget-api.ts`), so they cannot disagree about what "reachable" means.
 */
import { createConnection } from 'node:net';

export const reachable = async (url: string): Promise<boolean> => {
  const { hostname, port } = new URL(url);
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: hostname, port: Number(port || 5432) });
    const done = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1_000, () => {
      done(false);
    });
    socket.once('connect', () => {
      done(true);
    });
    socket.once('error', () => {
      done(false);
    });
  });
};
