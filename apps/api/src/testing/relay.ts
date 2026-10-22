/**
 * A relay on this machine that speaks just enough SMTP to accept a message, and records each command:
 * what nodemailer actually tells a relay, not what its options say it will.
 */
export const aRelay = (
  greeting = '220 relay.test ready',
): {
  readonly port: number;
  readonly commands: string[];
  readonly stop: () => void;
} => {
  const commands: string[] = [];
  let inData = false;
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: (socket) => {
        socket.write(`${greeting}\r\n`);
      },
      data: (socket, chunk) => {
        for (const line of chunk
          .toString()
          .split('\r\n')
          .filter((part) => part !== '')) {
          if (inData) {
            if (line === '.') {
              inData = false;
              socket.write('250 queued\r\n');
            }
            continue;
          }
          commands.push(line);
          const verb = line.split(/[ :]/)[0]?.toUpperCase();
          if (verb === 'EHLO' || verb === 'HELO') socket.write('250 relay.test\r\n');
          else if (verb === 'DATA') {
            inData = true;
            socket.write('354 go on\r\n');
          } else if (verb === 'QUIT') {
            socket.write('221 bye\r\n');
            socket.end();
          } else socket.write('250 ok\r\n');
        }
      },
    },
  });
  return {
    port: server.port,
    commands,
    stop: (): void => {
      server.stop(true);
    },
  };
};
